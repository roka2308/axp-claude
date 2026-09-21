ALTER TABLE `source_bindings` ADD `reviewed_at` datetime(3);--> statement-breakpoint
ALTER TABLE `source_bindings` ADD `reviewed_by_user_id` char(36);--> statement-breakpoint
ALTER TABLE `source_bindings` ADD `reviewed_fingerprint` varchar(256);--> statement-breakpoint
ALTER TABLE `source_bindings` ADD CONSTRAINT `source_bindings_reviewed_by_user_id_users_id_fk` FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- `audit_events.action` is an enum, and AuditService swallows write failures
-- by design, so a new action that is not listed here is never recorded and
-- never complains. `persistence-rules.test.ts` guards the two lists.
ALTER TABLE `audit_events` MODIFY COLUMN `action` enum('platform.bootstrap.started','platform.bootstrap.completed','platform.bootstrap.rejected','platform.recovery.started','platform.recovery.completed','auth.login.succeeded','auth.login.failed','auth.logout','auth.session.revoked','auth.password.changed','auth.reauthenticated','tenant.created','tenant.lifecycle.changed','tenant.purged','project.created','project.updated','user.invited','user.activated','user.deactivated','user.updated','role_assignment.created','role_assignment.removed','group.membership.changed','object_grant.changed','matomo_connection.created','matomo_connection.credential_replaced','matomo_connection.capabilities_refreshed','matomo_connection.removed','matomo_site.imported','project.site_assigned','semantic.version_activated','semantic.version_deprecated','source_binding.changed','source_binding.reviewed','dashboard.created','dashboard.published','dashboard.rolled_back','dashboard.archived','dashboard.trashed','dashboard.restored','dashboard.editor_takeover') NOT NULL;
