CREATE TABLE `attention_items` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`project_id` char(36),
	`kind` enum('report_failed','report_recipient_without_access','share_expiring','mapping_review','inactivity_review') NOT NULL,
	`severity` enum('action_required','warning','information') NOT NULL,
	`status` enum('open','acknowledged','resolved') NOT NULL DEFAULT 'open',
	`group_key` varchar(191) NOT NULL,
	`audience_capability` varchar(64) NOT NULL,
	`owner_user_id` char(36),
	`message_key` varchar(120) NOT NULL,
	`message_params` json NOT NULL DEFAULT ('{}'),
	`href` varchar(255),
	`occurrences` int NOT NULL DEFAULT 1,
	`first_seen_at` datetime(3) NOT NULL,
	`last_seen_at` datetime(3) NOT NULL,
	`acknowledged_at` datetime(3),
	`acknowledged_by_user_id` char(36),
	`resolved_at` datetime(3),
	`mailed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `attention_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_attention_group` UNIQUE(`tenant_id`,`group_key`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36),
	`kind` enum('report.deliver') NOT NULL,
	`payload` json NOT NULL,
	`status` enum('queued','running','succeeded','failed','dead','cancelled') NOT NULL DEFAULT 'queued',
	`attempts` int NOT NULL DEFAULT 0,
	`max_attempts` int NOT NULL DEFAULT 3,
	`run_after` datetime(3) NOT NULL,
	`locked_by` varchar(64),
	`locked_until` datetime(3),
	`dedupe_key` varchar(191),
	`last_error_code` varchar(100),
	`correlation_id` varchar(64),
	`started_at` datetime(3),
	`finished_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_jobs_dedupe` UNIQUE(`dedupe_key`)
);
--> statement-breakpoint
CREATE TABLE `report_runs` (
	`id` char(36) NOT NULL,
	`schedule_id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`planned_for` datetime(3) NOT NULL,
	`trigger` enum('schedule','manual') NOT NULL,
	`status` enum('queued','running','delivered','partially_delivered','failed','skipped') NOT NULL DEFAULT 'queued',
	`attempts` int NOT NULL DEFAULT 0,
	`job_id` char(36),
	`published_version` int,
	`period_from` varchar(10),
	`period_to` varchar(10),
	`delivered` int NOT NULL DEFAULT 0,
	`skipped` json NOT NULL DEFAULT ('[]'),
	`error_key` varchar(120),
	`started_at` datetime(3),
	`finished_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `report_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_report_runs_occurrence` UNIQUE(`schedule_id`,`planned_for`,`trigger`)
);
--> statement-breakpoint
CREATE TABLE `report_schedules` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`project_id` char(36) NOT NULL,
	`dashboard_id` char(36) NOT NULL,
	`name` varchar(120) NOT NULL,
	`format` enum('pdf','xlsx','pptx') NOT NULL,
	`period` varchar(32) NOT NULL,
	`comparison` varchar(32) NOT NULL,
	`rhythm` json NOT NULL,
	`timezone` varchar(64) NOT NULL,
	`delivery_mode` enum('attachment','link') NOT NULL,
	`recipient_user_ids` json NOT NULL,
	`paused` int NOT NULL DEFAULT 0,
	`next_run_at` datetime(3),
	`owner_user_id` char(36),
	`deleted_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `report_schedules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `audit_events` MODIFY COLUMN `action` enum('platform.bootstrap.started','platform.bootstrap.completed','platform.bootstrap.rejected','platform.recovery.started','platform.recovery.completed','auth.login.succeeded','auth.login.failed','auth.logout','auth.session.revoked','auth.password.changed','auth.reauthenticated','tenant.created','tenant.lifecycle.changed','tenant.purged','project.created','project.updated','user.invited','user.invitation.accepted','user.activated','user.deactivated','user.updated','role_assignment.created','role_assignment.removed','group.created','group.updated','group.deleted','group.membership.changed','object_grant.changed','matomo_connection.created','matomo_connection.credential_replaced','matomo_connection.capabilities_refreshed','matomo_connection.removed','matomo_site.imported','project.site_assigned','semantic.version_activated','semantic.version_deprecated','source_binding.changed','source_binding.reviewed','dashboard.created','dashboard.published','dashboard.rolled_back','dashboard.archived','dashboard.trashed','dashboard.restored','dashboard.editor_takeover','solution.installed','solution.exported','project.context_updated','share.created','share.revoked','export.created','report_schedule.created','report_schedule.updated','report_schedule.paused','report_schedule.resumed','report_schedule.deleted','report.run_finished','attention.acknowledged') NOT NULL;--> statement-breakpoint
ALTER TABLE `attention_items` ADD CONSTRAINT `attention_items_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attention_items` ADD CONSTRAINT `attention_items_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attention_items` ADD CONSTRAINT `attention_items_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attention_items` ADD CONSTRAINT `attention_items_acknowledged_by_user_id_users_id_fk` FOREIGN KEY (`acknowledged_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `report_runs` ADD CONSTRAINT `report_runs_schedule_id_report_schedules_id_fk` FOREIGN KEY (`schedule_id`) REFERENCES `report_schedules`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `report_runs` ADD CONSTRAINT `report_runs_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `report_schedules` ADD CONSTRAINT `report_schedules_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `report_schedules` ADD CONSTRAINT `report_schedules_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `report_schedules` ADD CONSTRAINT `report_schedules_dashboard_id_dashboards_id_fk` FOREIGN KEY (`dashboard_id`) REFERENCES `dashboards`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `report_schedules` ADD CONSTRAINT `report_schedules_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_attention_open` ON `attention_items` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_jobs_claim` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE INDEX `idx_jobs_tenant` ON `jobs` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_report_runs_schedule` ON `report_runs` (`schedule_id`,`planned_for`);--> statement-breakpoint
CREATE INDEX `idx_report_schedules_due` ON `report_schedules` (`paused`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `idx_report_schedules_project` ON `report_schedules` (`project_id`);