CREATE TABLE `diagnostic_artifacts` (
	`id` char(36) NOT NULL,
	`created_by_user_id` char(36),
	`file_name` varchar(255) NOT NULL,
	`byte_size` int NOT NULL,
	`storage_key` char(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `diagnostic_artifacts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_diagnostic_artifacts_storage` UNIQUE(`storage_key`)
);
--> statement-breakpoint
CREATE TABLE `tenant_entitlements` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`entitlement` varchar(64) NOT NULL,
	`enabled` int NOT NULL,
	`changed_by_user_id` char(36),
	`changed_at` datetime(3) NOT NULL,
	CONSTRAINT `tenant_entitlements_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_tenant_entitlement` UNIQUE(`tenant_id`,`entitlement`)
);
--> statement-breakpoint
CREATE TABLE `theme_versions` (
	`id` char(36) NOT NULL,
	`theme_id` char(36) NOT NULL,
	`version` int NOT NULL,
	`name` varchar(120) NOT NULL,
	`tokens` json NOT NULL,
	`dark_tokens` json NOT NULL,
	`rolled_back_from_version` int,
	`published_by_user_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `theme_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_theme_versions` UNIQUE(`theme_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `themes` (
	`id` char(36) NOT NULL,
	`scope` enum('platform','tenant','project') NOT NULL,
	`scope_key` varchar(64) NOT NULL,
	`tenant_id` char(36),
	`project_id` char(36),
	`published_version_id` char(36),
	`draft_name` varchar(120),
	`draft_tokens` json,
	`draft_dark_tokens` json,
	`draft_updated_at` datetime(3),
	`draft_updated_by_user_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `themes_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_themes_scope` UNIQUE(`scope_key`)
);
--> statement-breakpoint
ALTER TABLE `audit_events` MODIFY COLUMN `action` enum('platform.bootstrap.started','platform.bootstrap.completed','platform.bootstrap.rejected','platform.recovery.started','platform.recovery.completed','auth.login.succeeded','auth.login.failed','auth.logout','auth.session.revoked','auth.password.changed','auth.reauthenticated','tenant.created','tenant.lifecycle.changed','tenant.purged','project.created','project.updated','user.invited','user.invitation.accepted','user.activated','user.deactivated','user.updated','role_assignment.created','role_assignment.removed','group.created','group.updated','group.deleted','group.membership.changed','object_grant.changed','matomo_connection.created','matomo_connection.credential_replaced','matomo_connection.capabilities_refreshed','matomo_connection.removed','matomo_site.imported','project.site_assigned','semantic.version_activated','semantic.version_deprecated','source_binding.changed','source_binding.reviewed','dashboard.created','dashboard.published','dashboard.rolled_back','dashboard.archived','dashboard.trashed','dashboard.restored','dashboard.editor_takeover','solution.installed','solution.exported','project.context_updated','share.created','share.revoked','export.created','report_schedule.created','report_schedule.updated','report_schedule.paused','report_schedule.resumed','report_schedule.deleted','report.run_finished','attention.acknowledged','theme.published','theme.rolled_back','entitlement.changed','diagnostics.bundle_generated') NOT NULL;--> statement-breakpoint
ALTER TABLE `diagnostic_artifacts` ADD CONSTRAINT `diagnostic_artifacts_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tenant_entitlements` ADD CONSTRAINT `tenant_entitlements_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tenant_entitlements` ADD CONSTRAINT `tenant_entitlements_changed_by_user_id_users_id_fk` FOREIGN KEY (`changed_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `theme_versions` ADD CONSTRAINT `theme_versions_theme_id_themes_id_fk` FOREIGN KEY (`theme_id`) REFERENCES `themes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `theme_versions` ADD CONSTRAINT `theme_versions_published_by_user_id_users_id_fk` FOREIGN KEY (`published_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `themes` ADD CONSTRAINT `themes_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `themes` ADD CONSTRAINT `themes_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `themes` ADD CONSTRAINT `themes_draft_updated_by_user_id_users_id_fk` FOREIGN KEY (`draft_updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_diagnostic_artifacts_expiry` ON `diagnostic_artifacts` (`expires_at`);