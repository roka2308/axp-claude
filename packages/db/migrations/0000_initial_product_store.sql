CREATE TABLE `bootstrap_tokens` (
	`id` char(36) NOT NULL,
	`purpose` enum('initial_bootstrap','break_glass_recovery') NOT NULL,
	`token_hash` char(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`consumed_at` datetime(3),
	`consumed_by_user_id` char(36),
	`requested_by` varchar(255),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `bootstrap_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `bootstrap_tokens_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `platform_state` (
	`id` varchar(16) NOT NULL,
	`init_state` enum('uninitialized','initialized') NOT NULL DEFAULT 'uninitialized',
	`initialized_at` datetime(3),
	`initialized_by_user_id` char(36),
	`schema_version` varchar(32) NOT NULL DEFAULT '1',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `platform_state_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `auth_identities` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`provider_type` enum('local','oidc') NOT NULL,
	`provider_subject` varchar(320) NOT NULL,
	`password_hash` text,
	`password_updated_at` datetime(3),
	`must_change_password` int NOT NULL DEFAULT 0,
	`managed_attributes` json NOT NULL DEFAULT ('[]'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `auth_identities_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_auth_identity_provider_subject` UNIQUE(`provider_type`,`provider_subject`)
);
--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`id` char(36) NOT NULL,
	`subject_key` varchar(128) NOT NULL,
	`failed_count` int NOT NULL DEFAULT 0,
	`first_failed_at` datetime(3) NOT NULL,
	`last_failed_at` datetime(3) NOT NULL,
	`locked_until` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `login_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_login_attempts_subject` UNIQUE(`subject_key`)
);
--> statement-breakpoint
CREATE TABLE `password_history` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `password_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`authenticated_at` datetime(3) NOT NULL,
	`last_seen_at` datetime(3) NOT NULL,
	`absolute_expires_at` datetime(3) NOT NULL,
	`idle_expires_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	`revoked_reason` varchar(64),
	`ip_address` varchar(45),
	`user_agent` varchar(255),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `sessions_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` char(36) NOT NULL,
	`email` varchar(320) NOT NULL,
	`email_normalized` varchar(320) NOT NULL,
	`email_verified_at` datetime(3),
	`first_name` varchar(100) NOT NULL,
	`last_name` varchar(100) NOT NULL,
	`status` enum('invited','active','deactivated') NOT NULL DEFAULT 'invited',
	`locale` enum('de','en') NOT NULL DEFAULT 'de',
	`last_login_at` datetime(3),
	`deactivated_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_users_email_normalized` UNIQUE(`email_normalized`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`portable_id` varchar(128) NOT NULL,
	`name` varchar(200) NOT NULL,
	`slug` varchar(100) NOT NULL,
	`description` varchar(1000),
	`timezone` varchar(64) NOT NULL DEFAULT 'Europe/Berlin',
	`default_locale` enum('de','en') NOT NULL DEFAULT 'de',
	`setup_state` enum('setup_required','ready_with_limitations','ready') NOT NULL DEFAULT 'setup_required',
	`setup_checklist` json,
	`archived_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `projects_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_projects_tenant_slug` UNIQUE(`tenant_id`,`slug`),
	CONSTRAINT `uq_projects_tenant_portable_id` UNIQUE(`tenant_id`,`portable_id`)
);
--> statement-breakpoint
CREATE TABLE `tenant_memberships` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tenant_memberships_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_tenant_membership` UNIQUE(`tenant_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` char(36) NOT NULL,
	`portable_id` varchar(128) NOT NULL,
	`name` varchar(200) NOT NULL,
	`slug` varchar(100) NOT NULL,
	`lifecycle` enum('provisioning','active','suspended','offboarding','deleted') NOT NULL DEFAULT 'provisioning',
	`default_locale` enum('de','en') NOT NULL DEFAULT 'de',
	`lifecycle_changed_at` datetime(3),
	`lifecycle_changed_by_user_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tenants_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_tenants_slug` UNIQUE(`slug`),
	CONSTRAINT `uq_tenants_portable_id` UNIQUE(`portable_id`)
);
--> statement-breakpoint
CREATE TABLE `group_members` (
	`id` char(36) NOT NULL,
	`group_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `group_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_group_member` UNIQUE(`group_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`description` varchar(1000),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `groups_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_groups_tenant_name` UNIQUE(`tenant_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `object_grants` (
	`id` char(36) NOT NULL,
	`tenant_id` char(36) NOT NULL,
	`subject_type` enum('user','group') NOT NULL,
	`subject_id` char(36) NOT NULL,
	`object_type` varchar(40) NOT NULL,
	`object_id` char(36) NOT NULL,
	`access` enum('view','edit') NOT NULL,
	`granted_by_user_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `object_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_object_grant` UNIQUE(`subject_type`,`subject_id`,`object_type`,`object_id`,`access`)
);
--> statement-breakpoint
CREATE TABLE `role_assignments` (
	`id` char(36) NOT NULL,
	`subject_type` enum('user','group') NOT NULL,
	`subject_id` char(36) NOT NULL,
	`role` enum('viewer','dashboard_editor','semantic_catalog_manager','tenant_admin','platform_admin') NOT NULL,
	`scope_type` enum('platform','tenant','project') NOT NULL,
	`scope_id` varchar(36) NOT NULL DEFAULT '',
	`granted_by_user_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `role_assignments_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_role_assignment` UNIQUE(`subject_type`,`subject_id`,`role`,`scope_type`,`scope_id`)
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` char(36) NOT NULL,
	`action` enum('platform.bootstrap.started','platform.bootstrap.completed','platform.bootstrap.rejected','platform.recovery.started','platform.recovery.completed','auth.login.succeeded','auth.login.failed','auth.logout','auth.session.revoked','auth.password.changed','auth.reauthenticated','tenant.created','tenant.lifecycle.changed','tenant.purged','project.created','project.updated','user.invited','user.activated','user.deactivated','user.updated','role_assignment.created','role_assignment.removed','group.membership.changed','object_grant.changed') NOT NULL,
	`outcome` enum('success','failure') NOT NULL,
	`actor_user_id` char(36),
	`tenant_id` char(36),
	`project_id` char(36),
	`target_type` varchar(64),
	`target_id` varchar(64),
	`correlation_id` varchar(128),
	`ip_address` varchar(45),
	`user_agent` varchar(255),
	`metadata` json,
	`occurred_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `audit_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `auth_identities` ADD CONSTRAINT `auth_identities_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `password_history` ADD CONSTRAINT `password_history_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tenant_memberships` ADD CONSTRAINT `tenant_memberships_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tenant_memberships` ADD CONSTRAINT `tenant_memberships_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tenants` ADD CONSTRAINT `tenants_lifecycle_changed_by_user_id_users_id_fk` FOREIGN KEY (`lifecycle_changed_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `group_members` ADD CONSTRAINT `group_members_group_id_groups_id_fk` FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `group_members` ADD CONSTRAINT `group_members_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `groups` ADD CONSTRAINT `groups_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `object_grants` ADD CONSTRAINT `object_grants_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `object_grants` ADD CONSTRAINT `object_grants_granted_by_user_id_users_id_fk` FOREIGN KEY (`granted_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_assignments` ADD CONSTRAINT `role_assignments_granted_by_user_id_users_id_fk` FOREIGN KEY (`granted_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_bootstrap_tokens_expires` ON `bootstrap_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_bootstrap_tokens_purpose` ON `bootstrap_tokens` (`purpose`,`consumed_at`);--> statement-breakpoint
CREATE INDEX `idx_auth_identities_user` ON `auth_identities` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_login_attempts_locked` ON `login_attempts` (`locked_until`);--> statement-breakpoint
CREATE INDEX `idx_password_history_user` ON `password_history` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_expiry` ON `sessions` (`absolute_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_users_status` ON `users` (`status`);--> statement-breakpoint
CREATE INDEX `idx_projects_tenant` ON `projects` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_tenant_membership_user` ON `tenant_memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_tenants_lifecycle` ON `tenants` (`lifecycle`);--> statement-breakpoint
CREATE INDEX `idx_group_members_user` ON `group_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_object_grants_object` ON `object_grants` (`object_type`,`object_id`);--> statement-breakpoint
CREATE INDEX `idx_object_grants_tenant` ON `object_grants` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_role_assignments_subject` ON `role_assignments` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `idx_role_assignments_scope` ON `role_assignments` (`scope_type`,`scope_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_occurred` ON `audit_events` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_actor` ON `audit_events` (`actor_user_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_tenant` ON `audit_events` (`tenant_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_action` ON `audit_events` (`action`,`occurred_at`);