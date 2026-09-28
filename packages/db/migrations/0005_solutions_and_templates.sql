CREATE TABLE `solution_installations` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`project_id` char(36) NOT NULL,
	`package_id` varchar(128) NOT NULL,
	`package_version` varchar(20) NOT NULL,
	`name` varchar(200) NOT NULL,
	`publisher` varchar(200) NOT NULL,
	`content` json NOT NULL,
	`object_map` json NOT NULL,
	`current` int NOT NULL DEFAULT 1,
	`installed_by_user_id` char(36),
	`installed_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `solution_installations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` char(36) NOT NULL,
	`kind` enum('widget','dashboard') NOT NULL,
	`layer` enum('global','solution','tenant','project') NOT NULL,
	`tenant_id` char(36),
	`project_id` char(36),
	`portable_id` varchar(128) NOT NULL,
	`name` varchar(200) NOT NULL,
	`description` varchar(1000),
	`body` json NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`installation_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `templates_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_templates_scope` UNIQUE(`kind`,`portable_id`,`tenant_id`,`project_id`)
);
--> statement-breakpoint
ALTER TABLE `audit_events` MODIFY COLUMN `action` enum('platform.bootstrap.started','platform.bootstrap.completed','platform.bootstrap.rejected','platform.recovery.started','platform.recovery.completed','auth.login.succeeded','auth.login.failed','auth.logout','auth.session.revoked','auth.password.changed','auth.reauthenticated','tenant.created','tenant.lifecycle.changed','tenant.purged','project.created','project.updated','user.invited','user.invitation.accepted','user.activated','user.deactivated','user.updated','role_assignment.created','role_assignment.removed','group.created','group.updated','group.deleted','group.membership.changed','object_grant.changed','matomo_connection.created','matomo_connection.credential_replaced','matomo_connection.capabilities_refreshed','matomo_connection.removed','matomo_site.imported','project.site_assigned','semantic.version_activated','semantic.version_deprecated','source_binding.changed','source_binding.reviewed','dashboard.created','dashboard.published','dashboard.rolled_back','dashboard.archived','dashboard.trashed','dashboard.restored','dashboard.editor_takeover','solution.installed','solution.exported','project.context_updated') NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `context_profile` json;--> statement-breakpoint
ALTER TABLE `solution_installations` ADD CONSTRAINT `solution_installations_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `solution_installations` ADD CONSTRAINT `solution_installations_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `solution_installations` ADD CONSTRAINT `solution_installations_installed_by_user_id_users_id_fk` FOREIGN KEY (`installed_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `templates` ADD CONSTRAINT `templates_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `templates` ADD CONSTRAINT `templates_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `templates` ADD CONSTRAINT `templates_installation_id_solution_installations_id_fk` FOREIGN KEY (`installation_id`) REFERENCES `solution_installations`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_solution_installations_project` ON `solution_installations` (`project_id`,`package_id`);--> statement-breakpoint
CREATE INDEX `idx_solution_installations_tenant` ON `solution_installations` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_templates_project` ON `templates` (`project_id`);