-- Separate database for the integration test suite so tests can be reset
-- independently from the development database.
CREATE DATABASE IF NOT EXISTS `axp_test`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL PRIVILEGES ON `axp_test`.* TO 'axp'@'%';
FLUSH PRIVILEGES;
