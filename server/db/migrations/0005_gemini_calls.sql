CREATE TABLE `gemini_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text,
	`key_hash` text NOT NULL,
	`model` text NOT NULL,
	`ok` integer NOT NULL,
	`refused` integer DEFAULT false NOT NULL,
	`reported_limit` integer,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `gemini_calls_key_idx` ON `gemini_calls` (`key_hash`,`at`);