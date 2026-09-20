CREATE TABLE `matomo_capability_snapshots` (
	`id` char(36) NOT NULL,
	`connection_id` char(36) NOT NULL,
	`detected_at` datetime(3) NOT NULL,
	`matomo_version` varchar(40),
	`compatibility` enum('supported','supported_with_limitations','technically_compatible_not_certified','unsupported') NOT NULL,
	`probes` json NOT NULL,
	`limitation_keys` json NOT NULL DEFAULT ('[]'),
	`site_count` int,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `matomo_capability_snapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `matomo_connections` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`base_url` varchar(500) NOT NULL,
	`credential_ciphertext` text NOT NULL,
	`credential_nonce` varchar(64) NOT NULL,
	`credential_key_version` int NOT NULL DEFAULT 1,
	`credential_updated_at` datetime(3),
	`status` enum('untested','ok','failing','disabled') NOT NULL DEFAULT 'untested',
	`last_tested_at` datetime(3),
	`created_by_user_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `matomo_connections_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_matomo_connection_tenant_name` UNIQUE(`tenant_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `matomo_sites` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`connection_id` char(36) NOT NULL,
	`matomo_site_id` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`main_url` varchar(500),
	`timezone` varchar(64) NOT NULL,
	`currency` varchar(10),
	`ecommerce_enabled` boolean NOT NULL DEFAULT false,
	`metadata_refreshed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `matomo_sites_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_matomo_site_connection_site` UNIQUE(`connection_id`,`matomo_site_id`)
);
--> statement-breakpoint
CREATE TABLE `project_sites` (
	`id` char(36) NOT NULL,
	`project_id` char(36) NOT NULL,
	`site_id` char(36) NOT NULL,
	`is_primary` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `project_sites_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_project_site` UNIQUE(`project_id`,`site_id`)
);
--> statement-breakpoint
CREATE TABLE `semantic_definitions` (
	`id` char(36) NOT NULL,
	`portable_id` varchar(128) NOT NULL,
	`tenant_id` char(36),
	`project_id` char(36),
	`type` enum('native_metric','custom_metric','formula','score') NOT NULL,
	`name` varchar(200) NOT NULL,
	`description` varchar(1000),
	`current_version_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `semantic_definitions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_semantic_definition_scope` UNIQUE(`portable_id`,`tenant_id`,`project_id`)
);
--> statement-breakpoint
CREATE TABLE `semantic_versions` (
	`id` char(36) NOT NULL,
	`definition_id` char(36) NOT NULL,
	`version` int NOT NULL,
	`status` enum('draft','active','deprecated','archived') NOT NULL DEFAULT 'draft',
	`body` json NOT NULL,
	`dependency_version_ids` json NOT NULL DEFAULT ('[]'),
	`created_by_user_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `semantic_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_semantic_version` UNIQUE(`definition_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `source_bindings` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`project_id` char(36),
	`site_id` char(36),
	`requirement_key` varchar(128) NOT NULL,
	`binding` json NOT NULL,
	`created_by_user_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `source_bindings_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_source_binding_scope` UNIQUE(`project_id`,`site_id`,`requirement_key`)
);
--> statement-breakpoint
CREATE TABLE `dashboard_drafts` (
	`id` char(36) NOT NULL,
	`dashboard_id` char(36) NOT NULL,
	`revision_id` char(36) NOT NULL,
	`snapshot` json NOT NULL,
	`has_unpublished_changes` int NOT NULL DEFAULT 0,
	`lease_user_id` char(36),
	`lease_expires_at` datetime(3),
	`updated_by_user_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `dashboard_drafts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_dashboard_draft` UNIQUE(`dashboard_id`)
);
--> statement-breakpoint
CREATE TABLE `dashboard_versions` (
	`id` char(36) NOT NULL,
	`dashboard_id` char(36) NOT NULL,
	`version` int NOT NULL,
	`status` enum('published','archived') NOT NULL DEFAULT 'published',
	`snapshot` json NOT NULL,
	`pinned_semantic_version_ids` json NOT NULL DEFAULT ('[]'),
	`rolled_back_from_version` int,
	`published_by_user_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `dashboard_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_dashboard_version` UNIQUE(`dashboard_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `dashboards` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`project_id` char(36) NOT NULL,
	`site_id` char(36),
	`name` varchar(200) NOT NULL,
	`description` varchar(1000),
	`lifecycle` enum('draft','preview','published','archived','trash') NOT NULL DEFAULT 'draft',
	`published_version_id` char(36),
	`archived_at` datetime(3),
	`trashed_at` datetime(3),
	`created_by_user_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `dashboards_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `audit_events` MODIFY COLUMN `action` enum('platform.bootstrap.started','platform.bootstrap.completed','platform.bootstrap.rejected','platform.recovery.started','platform.recovery.completed','auth.login.succeeded','auth.login.failed','auth.logout','auth.session.revoked','auth.password.changed','auth.reauthenticated','tenant.created','tenant.lifecycle.changed','tenant.purged','project.created','project.updated','user.invited','user.activated','user.deactivated','user.updated','role_assignment.created','role_assignment.removed','group.membership.changed','object_grant.changed','matomo_connection.created','matomo_connection.credential_replaced','matomo_connection.capabilities_refreshed','matomo_connection.removed','matomo_site.imported','project.site_assigned','semantic.version_activated','semantic.version_deprecated','source_binding.changed','dashboard.created','dashboard.published','dashboard.rolled_back','dashboard.archived','dashboard.trashed') NOT NULL;--> statement-breakpoint
ALTER TABLE `matomo_capability_snapshots` ADD CONSTRAINT `fk_capability_snapshot_connection` FOREIGN KEY (`connection_id`) REFERENCES `matomo_connections`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `matomo_connections` ADD CONSTRAINT `matomo_connections_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `matomo_connections` ADD CONSTRAINT `matomo_connections_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `matomo_sites` ADD CONSTRAINT `matomo_sites_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `matomo_sites` ADD CONSTRAINT `matomo_sites_connection_id_matomo_connections_id_fk` FOREIGN KEY (`connection_id`) REFERENCES `matomo_connections`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `project_sites` ADD CONSTRAINT `project_sites_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `project_sites` ADD CONSTRAINT `project_sites_site_id_matomo_sites_id_fk` FOREIGN KEY (`site_id`) REFERENCES `matomo_sites`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `semantic_definitions` ADD CONSTRAINT `semantic_definitions_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `semantic_definitions` ADD CONSTRAINT `semantic_definitions_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `semantic_versions` ADD CONSTRAINT `semantic_versions_definition_id_semantic_definitions_id_fk` FOREIGN KEY (`definition_id`) REFERENCES `semantic_definitions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `semantic_versions` ADD CONSTRAINT `semantic_versions_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `source_bindings` ADD CONSTRAINT `source_bindings_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `source_bindings` ADD CONSTRAINT `source_bindings_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `source_bindings` ADD CONSTRAINT `source_bindings_site_id_matomo_sites_id_fk` FOREIGN KEY (`site_id`) REFERENCES `matomo_sites`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `source_bindings` ADD CONSTRAINT `source_bindings_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dashboard_drafts` ADD CONSTRAINT `dashboard_drafts_dashboard_id_dashboards_id_fk` FOREIGN KEY (`dashboard_id`) REFERENCES `dashboards`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dashboard_drafts` ADD CONSTRAINT `dashboard_drafts_lease_user_id_users_id_fk` FOREIGN KEY (`lease_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dashboard_drafts` ADD CONSTRAINT `dashboard_drafts_updated_by_user_id_users_id_fk` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dashboard_versions` ADD CONSTRAINT `dashboard_versions_dashboard_id_dashboards_id_fk` FOREIGN KEY (`dashboard_id`) REFERENCES `dashboards`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dashboard_versions` ADD CONSTRAINT `dashboard_versions_published_by_user_id_users_id_fk` FOREIGN KEY (`published_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dashboards` ADD CONSTRAINT `dashboards_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dashboards` ADD CONSTRAINT `dashboards_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dashboards` ADD CONSTRAINT `dashboards_site_id_matomo_sites_id_fk` FOREIGN KEY (`site_id`) REFERENCES `matomo_sites`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dashboards` ADD CONSTRAINT `dashboards_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_capability_snapshots_connection` ON `matomo_capability_snapshots` (`connection_id`,`detected_at`);--> statement-breakpoint
CREATE INDEX `idx_matomo_connections_tenant` ON `matomo_connections` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_matomo_sites_tenant` ON `matomo_sites` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_project_sites_site` ON `project_sites` (`site_id`);--> statement-breakpoint
CREATE INDEX `idx_semantic_definitions_project` ON `semantic_definitions` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_semantic_definitions_tenant` ON `semantic_definitions` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_semantic_versions_status` ON `semantic_versions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_source_bindings_tenant` ON `source_bindings` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_dashboard_versions_status` ON `dashboard_versions` (`dashboard_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_dashboards_project` ON `dashboards` (`project_id`,`lifecycle`);--> statement-breakpoint
CREATE INDEX `idx_dashboards_tenant` ON `dashboards` (`tenant_id`);