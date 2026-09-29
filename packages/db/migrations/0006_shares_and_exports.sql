CREATE TABLE `dashboard_shares` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`project_id` char(36) NOT NULL,
	`dashboard_id` char(36) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`label` varchar(120) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`allow_time_range` int NOT NULL DEFAULT 0,
	`allow_comparison` int NOT NULL DEFAULT 0,
	`allow_detail` int NOT NULL DEFAULT 0,
	`allow_export` int NOT NULL DEFAULT 0,
	`password_hash` varchar(255),
	`failed_unlocks` int NOT NULL DEFAULT 0,
	`unlock_blocked_until` datetime(3),
	`created_by_user_id` char(36),
	`revoked_at` datetime(3),
	`revoked_by_user_id` char(36),
	`last_accessed_at` datetime(3),
	`access_count` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `dashboard_shares_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_dashboard_shares_token` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `export_artifacts` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`dashboard_id` char(36) NOT NULL,
	`format` enum('pdf','xlsx','pptx','csv') NOT NULL,
	`requested_by_user_id` char(36),
	`share_id` char(36),
	`file_name` varchar(255) NOT NULL,
	`byte_size` int NOT NULL,
	`storage_key` char(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`download_count` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `export_artifacts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_export_artifacts_storage` UNIQUE(`storage_key`)
);
--> statement-breakpoint
CREATE TABLE `share_sessions` (
	`id` char(36) NOT NULL,
	`share_id` char(36) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `share_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_share_sessions_token` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `audit_events` MODIFY COLUMN `action` enum('platform.bootstrap.started','platform.bootstrap.completed','platform.bootstrap.rejected','platform.recovery.started','platform.recovery.completed','auth.login.succeeded','auth.login.failed','auth.logout','auth.session.revoked','auth.password.changed','auth.reauthenticated','tenant.created','tenant.lifecycle.changed','tenant.purged','project.created','project.updated','user.invited','user.invitation.accepted','user.activated','user.deactivated','user.updated','role_assignment.created','role_assignment.removed','group.created','group.updated','group.deleted','group.membership.changed','object_grant.changed','matomo_connection.created','matomo_connection.credential_replaced','matomo_connection.capabilities_refreshed','matomo_connection.removed','matomo_site.imported','project.site_assigned','semantic.version_activated','semantic.version_deprecated','source_binding.changed','source_binding.reviewed','dashboard.created','dashboard.published','dashboard.rolled_back','dashboard.archived','dashboard.trashed','dashboard.restored','dashboard.editor_takeover','solution.installed','solution.exported','project.context_updated','share.created','share.revoked','export.created') NOT NULL;--> statement-breakpoint
ALTER TABLE `dashboard_shares` ADD CONSTRAINT `dashboard_shares_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dashboard_shares` ADD CONSTRAINT `dashboard_shares_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dashboard_shares` ADD CONSTRAINT `dashboard_shares_dashboard_id_dashboards_id_fk` FOREIGN KEY (`dashboard_id`) REFERENCES `dashboards`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dashboard_shares` ADD CONSTRAINT `dashboard_shares_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dashboard_shares` ADD CONSTRAINT `dashboard_shares_revoked_by_user_id_users_id_fk` FOREIGN KEY (`revoked_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `export_artifacts` ADD CONSTRAINT `export_artifacts_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `export_artifacts` ADD CONSTRAINT `export_artifacts_dashboard_id_dashboards_id_fk` FOREIGN KEY (`dashboard_id`) REFERENCES `dashboards`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `export_artifacts` ADD CONSTRAINT `export_artifacts_requested_by_user_id_users_id_fk` FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `export_artifacts` ADD CONSTRAINT `export_artifacts_share_id_dashboard_shares_id_fk` FOREIGN KEY (`share_id`) REFERENCES `dashboard_shares`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `share_sessions` ADD CONSTRAINT `share_sessions_share_id_dashboard_shares_id_fk` FOREIGN KEY (`share_id`) REFERENCES `dashboard_shares`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_dashboard_shares_dashboard` ON `dashboard_shares` (`dashboard_id`);--> statement-breakpoint
CREATE INDEX `idx_dashboard_shares_tenant` ON `dashboard_shares` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_export_artifacts_expiry` ON `export_artifacts` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_share_sessions_expiry` ON `share_sessions` (`expires_at`);