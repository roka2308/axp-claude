CREATE TABLE `account_tokens` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`purpose` enum('password_reset','email_change') NOT NULL,
	`token_hash` char(64) NOT NULL,
	`new_email` varchar(320),
	`sealed_token` text,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `account_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `account_tokens_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `audit_events` MODIFY COLUMN `action` enum('platform.bootstrap.started','platform.bootstrap.completed','platform.bootstrap.rejected','platform.recovery.started','platform.recovery.completed','auth.login.succeeded','auth.login.failed','auth.logout','auth.session.revoked','auth.password.changed','auth.reauthenticated','auth.password.reset_requested','auth.password.reset','user.email.change_requested','user.email.changed','user.email.change_cancelled','tenant.created','tenant.lifecycle.changed','tenant.purged','project.created','project.updated','user.invited','user.invitation.accepted','user.activated','user.deactivated','user.updated','role_assignment.created','role_assignment.removed','group.created','group.updated','group.deleted','group.membership.changed','object_grant.changed','matomo_connection.created','matomo_connection.credential_replaced','matomo_connection.capabilities_refreshed','matomo_connection.removed','matomo_site.imported','project.site_assigned','semantic.version_activated','semantic.version_deprecated','source_binding.changed','source_binding.reviewed','dashboard.created','dashboard.published','dashboard.rolled_back','dashboard.archived','dashboard.trashed','dashboard.restored','dashboard.editor_takeover','solution.installed','solution.exported','project.context_updated','share.created','share.revoked','export.created','report_schedule.created','report_schedule.updated','report_schedule.paused','report_schedule.resumed','report_schedule.deleted','report.run_finished','attention.acknowledged','theme.published','theme.rolled_back','entitlement.changed','diagnostics.bundle_generated') NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` MODIFY COLUMN `kind` enum('report.deliver','account.mail') NOT NULL;--> statement-breakpoint
ALTER TABLE `user_invitations` ADD `sealed_token` text;--> statement-breakpoint
ALTER TABLE `account_tokens` ADD CONSTRAINT `account_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_account_tokens_user_purpose` ON `account_tokens` (`user_id`,`purpose`);