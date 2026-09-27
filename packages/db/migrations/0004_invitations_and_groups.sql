CREATE TABLE `user_invitations` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`tenant_id` char(36),
	`token_hash` char(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`created_by_user_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `user_invitations_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_invitations_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `audit_events` MODIFY COLUMN `action` enum('platform.bootstrap.started','platform.bootstrap.completed','platform.bootstrap.rejected','platform.recovery.started','platform.recovery.completed','auth.login.succeeded','auth.login.failed','auth.logout','auth.session.revoked','auth.password.changed','auth.reauthenticated','tenant.created','tenant.lifecycle.changed','tenant.purged','project.created','project.updated','user.invited','user.invitation.accepted','user.activated','user.deactivated','user.updated','role_assignment.created','role_assignment.removed','group.created','group.updated','group.deleted','group.membership.changed','object_grant.changed','matomo_connection.created','matomo_connection.credential_replaced','matomo_connection.capabilities_refreshed','matomo_connection.removed','matomo_site.imported','project.site_assigned','semantic.version_activated','semantic.version_deprecated','source_binding.changed','source_binding.reviewed','dashboard.created','dashboard.published','dashboard.rolled_back','dashboard.archived','dashboard.trashed','dashboard.restored','dashboard.editor_takeover') NOT NULL;--> statement-breakpoint
ALTER TABLE `user_invitations` ADD CONSTRAINT `user_invitations_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_invitations` ADD CONSTRAINT `user_invitations_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_user_invitations_user` ON `user_invitations` (`user_id`);
--> statement-breakpoint
-- New audit actions for groups and invitations. The enum and the contract list
-- are compared by `persistence-rules.test.ts`.
ALTER TABLE `audit_events` MODIFY COLUMN `action` enum('platform.bootstrap.started','platform.bootstrap.completed','platform.bootstrap.rejected','platform.recovery.started','platform.recovery.completed','auth.login.succeeded','auth.login.failed','auth.logout','auth.session.revoked','auth.password.changed','auth.reauthenticated','tenant.created','tenant.lifecycle.changed','tenant.purged','project.created','project.updated','user.invited','user.invitation.accepted','user.activated','user.deactivated','user.updated','role_assignment.created','role_assignment.removed','group.created','group.updated','group.deleted','group.membership.changed','object_grant.changed','matomo_connection.created','matomo_connection.credential_replaced','matomo_connection.capabilities_refreshed','matomo_connection.removed','matomo_site.imported','project.site_assigned','semantic.version_activated','semantic.version_deprecated','source_binding.changed','source_binding.reviewed','dashboard.created','dashboard.published','dashboard.rolled_back','dashboard.archived','dashboard.trashed','dashboard.restored','dashboard.editor_takeover') NOT NULL;
