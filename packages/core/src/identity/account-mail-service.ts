import { and, count, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { AppError, type AccountMailPurpose } from '@axp/contracts';
import {
  accountTokens,
  authIdentities,
  type Database,
  newId,
  tenants,
  userInvitations,
  users,
} from '@axp/db';
import type { Logger } from '@axp/observability';
import type { AuditService } from '../audit/audit-service';
import type { Clock } from '../clock';
import { generateSecretToken, hashToken, normalizeEmail } from '../crypto';
import type { ClaimedJob, JobQueue } from '../jobs/job-queue';
import type { JobHandler } from '../jobs/job-runner';
import type { MailTransport } from '../mail/mail-transport';
import type { SecretBox } from '../secret-box';
import type { UserService } from './user-service';

export interface AccountMailServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: AuditService;
  readonly jobs: JobQueue;
  readonly mail: MailTransport;
  readonly secretBox: SecretBox;
  readonly users: UserService;
  readonly revokeAllSessions: (userId: string, reason: string) => Promise<number>;
  readonly webUrl: string;
  readonly passwordResetTtlMinutes: number;
  readonly emailChangeTtlHours: number;
}

/** More requests than this per account and hour are answered, and dropped. */
const RESET_REQUESTS_PER_HOUR = 3;

/** A mail could not be handed over; the queue retries it. */
class AccountMailError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AccountMailError';
  }
}

/**
 * Links that go to a person's own mailbox (Master Spec §6, §12; DEV-005):
 * invitations, "Passwort vergessen" and the verification of a new e-mail
 * address.
 *
 * Every link is single-use and expires; only its hash identifies it. Mail goes
 * through the durable job queue (ADR 0010): the job names a record, and the
 * record keeps the token encrypted - bound to its own id - until the mail has
 * gone out. After that the product could not re-send the link if it wanted to.
 *
 * Recovery never says whether an address has an account: the answer, the
 * work done in the request and the audit trail visible to the caller are the
 * same either way.
 */
export class AccountMailService {
  constructor(private readonly deps: AccountMailServiceDeps) {}

  // --- invitations -----------------------------------------------------------

  /** Called when an invitation is issued: the invited person gets the link by mail. */
  async queueInvitation(invitationId: string, token: string, tenantId: string | null) {
    await this.deps.db
      .update(userInvitations)
      .set({ sealedToken: this.seal('invitation', invitationId, token) })
      .where(eq(userInvitations.id, invitationId));
    await this.deps.jobs.enqueue({
      kind: 'account.mail',
      payload: { purpose: 'invitation', recordId: invitationId },
      tenantId,
      dedupeKey: `account.mail:invitation:${invitationId}`,
    });
  }

  // --- password recovery -----------------------------------------------------

  /**
   * "Passwort vergessen". Returns nothing, whatever the address: an active
   * account with a local password gets a link, anything else gets nothing.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const now = this.deps.clock.now();
    const [account] = await this.deps.db
      .select({ id: users.id, status: users.status, passwordHash: authIdentities.passwordHash })
      .from(users)
      .innerJoin(
        authIdentities,
        and(eq(authIdentities.userId, users.id), eq(authIdentities.providerType, 'local')),
      )
      .where(eq(users.emailNormalized, normalizeEmail(email)))
      .limit(1);

    if (!account || account.status !== 'active' || account.passwordHash === null) {
      this.deps.logger.info({ recovery: 'no_link' }, 'Password reset requested');
      return;
    }

    const [recent] = await this.deps.db
      .select({ value: count() })
      .from(accountTokens)
      .where(
        and(
          eq(accountTokens.userId, account.id),
          eq(accountTokens.purpose, 'password_reset'),
          gt(accountTokens.createdAt, new Date(now.getTime() - 3_600_000)),
        ),
      );
    if ((recent?.value ?? 0) >= RESET_REQUESTS_PER_HOUR) {
      this.deps.logger.info({ recovery: 'throttled' }, 'Password reset requested');
      return;
    }

    await this.issue({
      userId: account.id,
      purpose: 'password_reset',
      expiresAt: new Date(now.getTime() + this.deps.passwordResetTtlMinutes * 60_000),
    });
    await this.deps.audit.success('auth.password.reset_requested', {
      actorUserId: null,
      targetType: 'user',
      targetId: account.id,
    });
  }

  /** Whether a reset link can still be used - for the page that opens it. */
  async inspectPasswordReset(token: string): Promise<boolean> {
    return (await this.findUsable(token, 'password_reset')) !== null;
  }

  /**
   * Sets a new password from a reset link. The password rules and history
   * apply as everywhere; every session ends, because whoever made recovery
   * necessary may hold one.
   */
  async completePasswordReset(input: { token: string; newPassword: string }): Promise<void> {
    const row = await this.findUsable(input.token, 'password_reset');
    if (!row) throw linkInvalid('password_reset');

    await this.deps.users.changePassword({
      userId: row.userId,
      newPassword: input.newPassword,
      requireCurrent: false,
      actorUserId: row.userId,
    });
    const now = this.deps.clock.now();
    await this.deps.db.transaction(async (tx) => {
      await tx.update(accountTokens).set({ usedAt: now }).where(eq(accountTokens.id, row.id));
      // Every other open reset link for this account stops working too.
      await tx
        .update(accountTokens)
        .set({ usedAt: now, sealedToken: null })
        .where(
          and(
            eq(accountTokens.userId, row.userId),
            eq(accountTokens.purpose, 'password_reset'),
            isNull(accountTokens.usedAt),
          ),
        );
      // Receiving the mail proved the address.
      await tx
        .update(users)
        .set({ emailVerifiedAt: now })
        .where(and(eq(users.id, row.userId), isNull(users.emailVerifiedAt)));
    });
    await this.deps.revokeAllSessions(row.userId, 'password_reset');
    await this.deps.audit.success('auth.password.reset', {
      actorUserId: row.userId,
      targetType: 'user',
      targetId: row.userId,
    });
  }

  // --- verified address change -----------------------------------------------

  /**
   * Starts an address change: the current password is confirmed here, the new
   * address must prove itself by its link, and the current address is told.
   */
  async requestEmailChange(input: {
    userId: string;
    newEmail: string;
    currentPassword: string;
  }): Promise<{ newEmail: string; expiresAt: string }> {
    const [identity] = await this.deps.db
      .select({
        email: users.emailNormalized,
        managed: authIdentities.managedAttributes,
      })
      .from(users)
      .innerJoin(
        authIdentities,
        and(eq(authIdentities.userId, users.id), eq(authIdentities.providerType, 'local')),
      )
      .where(eq(users.id, input.userId))
      .limit(1);

    if (!identity || ((identity.managed ?? []) as string[]).includes('email')) {
      throw new AppError('validation_failed', {
        code: 'email_managed',
        messageKey: 'profile.email_managed',
        internalMessage: `User ${input.userId} has no locally managed e-mail address.`,
      });
    }

    if (!(await this.deps.users.passwordMatches(input.userId, input.currentPassword))) {
      await this.deps.audit.record({
        action: 'user.email.change_requested',
        outcome: 'failure',
        actorUserId: input.userId,
        targetType: 'user',
        targetId: input.userId,
      });
      throw new AppError('authentication_required', {
        code: 'current_password_invalid',
        messageKey: 'auth.current_password_invalid',
        fieldErrors: { currentPassword: 'auth.current_password_invalid' },
      });
    }

    const normalized = normalizeEmail(input.newEmail);
    if (normalized === identity.email) {
      throw new AppError('validation_failed', {
        code: 'email_unchanged',
        messageKey: 'profile.email_unchanged',
        fieldErrors: { newEmail: 'profile.email_unchanged' },
      });
    }
    await this.assertAddressFree(normalized);

    const now = this.deps.clock.now();
    const expiresAt = new Date(now.getTime() + this.deps.emailChangeTtlHours * 3_600_000);
    await this.issue({
      userId: input.userId,
      purpose: 'email_change',
      newEmail: input.newEmail.trim(),
      expiresAt,
    });
    await this.deps.audit.success('user.email.change_requested', {
      actorUserId: input.userId,
      targetType: 'user',
      targetId: input.userId,
    });
    return { newEmail: input.newEmail.trim(), expiresAt: expiresAt.toISOString() };
  }

  /** The address change waiting for its confirmation, if any. */
  async pendingEmailChange(
    userId: string,
  ): Promise<{ newEmail: string; expiresAt: string } | null> {
    const [row] = await this.deps.db
      .select({ newEmail: accountTokens.newEmail, expiresAt: accountTokens.expiresAt })
      .from(accountTokens)
      .where(
        and(
          eq(accountTokens.userId, userId),
          eq(accountTokens.purpose, 'email_change'),
          isNull(accountTokens.usedAt),
          gt(accountTokens.expiresAt, this.deps.clock.now()),
        ),
      )
      .limit(1);
    return row?.newEmail
      ? { newEmail: row.newEmail, expiresAt: row.expiresAt.toISOString() }
      : null;
  }

  async cancelEmailChange(userId: string): Promise<void> {
    const retired = await this.retire(userId, 'email_change');
    if (retired > 0) {
      await this.deps.audit.success('user.email.change_cancelled', {
        actorUserId: userId,
        targetType: 'user',
        targetId: userId,
      });
    }
  }

  /** Confirms a new address by its link. Sign-in uses the new address from now on. */
  async confirmEmailChange(token: string): Promise<{ email: string }> {
    const row = await this.findUsable(token, 'email_change');
    if (!row?.newEmail) throw linkInvalid('email_change');
    const normalized = normalizeEmail(row.newEmail);
    await this.assertAddressFree(normalized, row.userId);

    const now = this.deps.clock.now();
    await this.deps.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ email: row.newEmail!, emailNormalized: normalized, emailVerifiedAt: now })
        .where(eq(users.id, row.userId));
      await tx
        .update(authIdentities)
        .set({ providerSubject: normalized })
        .where(
          and(eq(authIdentities.userId, row.userId), eq(authIdentities.providerType, 'local')),
        );
      await tx
        .update(accountTokens)
        .set({ usedAt: now, sealedToken: null })
        .where(eq(accountTokens.id, row.id));
    });
    await this.deps.audit.success('user.email.changed', {
      actorUserId: row.userId,
      targetType: 'user',
      targetId: row.userId,
    });
    return { email: row.newEmail };
  }

  // --- delivery ----------------------------------------------------------------

  asJobHandler(): JobHandler {
    return {
      run: (job) => this.deliver(job),
      classify: (error) =>
        error instanceof AccountMailError
          ? { code: error.code, retryable: true }
          : { code: 'account_mail.unexpected', retryable: true },
    };
  }

  /** The job handler for `account.mail`. */
  async deliver(job: ClaimedJob): Promise<'done' | 'cancelled'> {
    const purpose = job.payload.purpose as AccountMailPurpose;
    const recordId = String(job.payload.recordId);
    const now = this.deps.clock.now();

    const record =
      purpose === 'invitation'
        ? await this.invitationRecord(recordId)
        : await this.tokenRecord(recordId, purpose);
    // Used, expired, replaced or already sent: nothing to send any more.
    if (!record || record.usedAt || record.expiresAt <= now || !record.sealedToken) {
      return 'cancelled';
    }

    const token = this.open(purpose, recordId, record.sealedToken);
    const english = record.locale === 'en';
    const messages = accountMails({
      purpose,
      english,
      firstName: record.firstName,
      tenantName: record.tenantName,
      newEmail: record.newEmail,
      link: this.link(purpose, token),
      expiresAt: record.expiresAt,
    });

    const recipients = [
      {
        address: purpose === 'email_change' ? record.newEmail! : record.email,
        message: messages.primary,
      },
      // The current address hears about an address change, without the link.
      ...(purpose === 'email_change' && messages.notice
        ? [{ address: record.email, message: messages.notice }]
        : []),
    ];
    for (const recipient of recipients) {
      try {
        await this.deps.mail.send({
          to: { address: recipient.address, name: record.firstName },
          subject: recipient.message.subject,
          text: recipient.message.text,
        });
      } catch (error) {
        this.deps.logger.warn({ err: error, purpose }, 'Account mail could not be sent');
        throw new AccountMailError('account_mail.send_failed');
      }
    }

    if (purpose === 'invitation') {
      await this.deps.db
        .update(userInvitations)
        .set({ sealedToken: null })
        .where(eq(userInvitations.id, recordId));
    } else {
      await this.deps.db
        .update(accountTokens)
        .set({ sealedToken: null })
        .where(eq(accountTokens.id, recordId));
    }
    return 'done';
  }

  /** Removes encrypted tokens and old rows once their links can no longer be used. */
  async purgeExpired(): Promise<number> {
    const now = this.deps.clock.now();
    await this.deps.db
      .update(userInvitations)
      .set({ sealedToken: null })
      .where(
        and(
          isNotNull(userInvitations.sealedToken),
          or(lt(userInvitations.expiresAt, now), isNotNull(userInvitations.usedAt)),
        ),
      );
    const [result] = await this.deps.db
      .delete(accountTokens)
      .where(lt(accountTokens.expiresAt, new Date(now.getTime() - 7 * 86_400_000)));
    return (result as { affectedRows?: number }).affectedRows ?? 0;
  }

  // --- internals ---------------------------------------------------------------

  private async issue(input: {
    userId: string;
    purpose: 'password_reset' | 'email_change';
    newEmail?: string;
    expiresAt: Date;
  }): Promise<void> {
    // One open link per purpose and person: a new one retires the old.
    if (input.purpose === 'email_change') await this.retire(input.userId, 'email_change');
    const id = newId();
    const token = generateSecretToken();
    await this.deps.db.insert(accountTokens).values({
      id,
      userId: input.userId,
      purpose: input.purpose,
      tokenHash: hashToken(token),
      newEmail: input.newEmail ?? null,
      sealedToken: this.seal(input.purpose, id, token),
      expiresAt: input.expiresAt,
    });
    await this.deps.jobs.enqueue({
      kind: 'account.mail',
      payload: { purpose: input.purpose, recordId: id },
      dedupeKey: `account.mail:${input.purpose}:${id}`,
    });
  }

  private async retire(userId: string, purpose: 'password_reset' | 'email_change') {
    const [result] = await this.deps.db
      .update(accountTokens)
      .set({ usedAt: this.deps.clock.now(), sealedToken: null })
      .where(
        and(
          eq(accountTokens.userId, userId),
          eq(accountTokens.purpose, purpose),
          isNull(accountTokens.usedAt),
        ),
      );
    return (result as { affectedRows?: number }).affectedRows ?? 0;
  }

  private async findUsable(token: string, purpose: 'password_reset' | 'email_change') {
    if (!token) return null;
    const [row] = await this.deps.db
      .select()
      .from(accountTokens)
      .innerJoin(users, eq(users.id, accountTokens.userId))
      .where(
        and(
          eq(accountTokens.tokenHash, hashToken(token)),
          eq(accountTokens.purpose, purpose),
          isNull(accountTokens.usedAt),
          gt(accountTokens.expiresAt, this.deps.clock.now()),
        ),
      )
      .limit(1);
    // A deactivated account cannot be recovered or changed by link.
    if (!row || row.users.status !== 'active') return null;
    return row.account_tokens;
  }

  private async assertAddressFree(normalized: string, exceptUserId?: string) {
    const [taken] = await this.deps.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.emailNormalized, normalized))
      .limit(1);
    if (taken && taken.id !== exceptUserId) {
      throw new AppError('conflict', {
        code: 'email_already_used',
        messageKey: 'user.email_already_used',
        fieldErrors: { newEmail: 'user.email_already_used' },
      });
    }
  }

  private async invitationRecord(id: string) {
    const [row] = await this.deps.db
      .select({
        usedAt: userInvitations.usedAt,
        expiresAt: userInvitations.expiresAt,
        sealedToken: userInvitations.sealedToken,
        email: users.email,
        firstName: users.firstName,
        locale: users.locale,
        tenantName: tenants.name,
      })
      .from(userInvitations)
      .innerJoin(users, eq(users.id, userInvitations.userId))
      .leftJoin(tenants, eq(tenants.id, userInvitations.tenantId))
      .where(eq(userInvitations.id, id))
      .limit(1);
    return row ? { ...row, newEmail: null } : null;
  }

  private async tokenRecord(id: string, purpose: AccountMailPurpose) {
    const [row] = await this.deps.db
      .select({
        usedAt: accountTokens.usedAt,
        expiresAt: accountTokens.expiresAt,
        sealedToken: accountTokens.sealedToken,
        newEmail: accountTokens.newEmail,
        email: users.email,
        firstName: users.firstName,
        locale: users.locale,
        status: users.status,
      })
      .from(accountTokens)
      .innerJoin(users, eq(users.id, accountTokens.userId))
      .where(and(eq(accountTokens.id, id), eq(accountTokens.purpose, purpose as never)))
      .limit(1);
    if (!row || row.status !== 'active') return null;
    return { ...row, tenantName: null };
  }

  private link(purpose: AccountMailPurpose, token: string): string {
    const path =
      purpose === 'invitation'
        ? '/invite'
        : purpose === 'password_reset'
          ? '/reset-password'
          : '/profile/email/confirm';
    return `${this.deps.webUrl}${path}?token=${encodeURIComponent(token)}`;
  }

  private seal(purpose: AccountMailPurpose, recordId: string, token: string): string {
    return this.deps.secretBox
      .sealBytes(Buffer.from(token, 'utf8'), `account-mail:${purpose}:${recordId}`)
      .toString('base64');
  }

  private open(purpose: AccountMailPurpose, recordId: string, sealed: string): string {
    return this.deps.secretBox
      .openBytes(Buffer.from(sealed, 'base64'), `account-mail:${purpose}:${recordId}`)
      .toString('utf8');
  }
}

function linkInvalid(purpose: 'password_reset' | 'email_change'): AppError {
  return new AppError('not_found', {
    code: `${purpose}_link_invalid`,
    messageKey:
      purpose === 'password_reset' ? 'recovery.link_invalid' : 'profile.email_link_invalid',
  });
}

interface MailText {
  readonly subject: string;
  readonly text: string;
}

/** The mails themselves: plain text, in the person's language, no tracking. */
export function accountMails(input: {
  purpose: AccountMailPurpose;
  english: boolean;
  firstName: string;
  tenantName: string | null;
  newEmail: string | null;
  link: string;
  expiresAt: Date;
}): { primary: MailText; notice?: MailText } {
  const { english, firstName, link } = input;
  const until = formatUtc(input.expiresAt, english);
  const greeting = english ? `Hello ${firstName},` : `Hallo ${firstName},`;
  const ignore = english
    ? 'If you did not expect this mail, you can ignore it.'
    : 'Wenn Sie diese Mail nicht erwartet haben, können Sie sie ignorieren.';

  if (input.purpose === 'invitation') {
    const where = input.tenantName ? ` (${input.tenantName})` : '';
    return {
      primary: {
        subject: english
          ? 'Your invitation to Analytics Experience'
          : 'Ihre Einladung zu Analytics Experience',
        text: [
          greeting,
          '',
          english
            ? `you have been invited to Analytics Experience${where}. Choose your password with this link - it works once:`
            : `Sie wurden zu Analytics Experience${where} eingeladen. Mit diesem Link wählen Sie Ihr Passwort – er funktioniert einmal:`,
          link,
          '',
          english ? `The link is valid until ${until}.` : `Der Link gilt bis ${until}.`,
          ignore,
        ].join('\n'),
      },
    };
  }

  if (input.purpose === 'password_reset') {
    return {
      primary: {
        subject: english
          ? 'Reset your Analytics Experience password'
          : 'Passwort für Analytics Experience zurücksetzen',
        text: [
          greeting,
          '',
          english
            ? 'someone asked to reset the password of this account. Choose a new password with this link - it works once:'
            : 'für dieses Konto wurde ein neues Passwort angefordert. Mit diesem Link wählen Sie es – er funktioniert einmal:',
          link,
          '',
          english ? `The link is valid until ${until}.` : `Der Link gilt bis ${until}.`,
          english
            ? 'Setting a new password signs you out everywhere.'
            : 'Mit dem neuen Passwort werden Sie überall abgemeldet.',
          english
            ? 'If you did not ask for this, ignore this mail: your password stays as it is.'
            : 'Wenn Sie das nicht angefordert haben, ignorieren Sie diese Mail: Ihr Passwort bleibt, wie es ist.',
        ].join('\n'),
      },
    };
  }

  return {
    primary: {
      subject: english
        ? 'Confirm your new e-mail address'
        : 'Bestätigen Sie Ihre neue E-Mail-Adresse',
      text: [
        greeting,
        '',
        english
          ? 'please confirm that Analytics Experience should use this address from now on:'
          : 'bitte bestätigen Sie, dass Analytics Experience ab jetzt diese Adresse verwendet:',
        link,
        '',
        english ? `The link is valid until ${until}.` : `Der Link gilt bis ${until}.`,
        ignore,
      ].join('\n'),
    },
    notice: {
      subject: english
        ? 'Your e-mail address is about to change'
        : 'Ihre E-Mail-Adresse soll geändert werden',
      text: [
        greeting,
        '',
        english
          ? `a change of your Analytics Experience address to ${input.newEmail} was requested. It takes effect only once the new address is confirmed.`
          : `Für Ihr Konto bei Analytics Experience wurde eine Änderung der Adresse auf ${input.newEmail} angefordert. Sie wird erst wirksam, wenn die neue Adresse bestätigt ist.`,
        '',
        english
          ? 'If this was not you, sign in, cancel the change under "My profile" and change your password.'
          : 'Wenn Sie das nicht waren, melden Sie sich an, brechen Sie die Änderung unter „Mein Profil“ ab und ändern Sie Ihr Passwort.',
      ].join('\n'),
    },
  };
}

function formatUtc(instant: Date, english: boolean): string {
  const iso = instant.toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  return english ? `${date} ${time} UTC` : `${date.split('-').reverse().join('.')} ${time} UTC`;
}
