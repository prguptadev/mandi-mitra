UPDATE `adati` SET `name_hinglish` = upper(`name_hinglish`) WHERE `name_hinglish` <> upper(`name_hinglish`);--> statement-breakpoint
UPDATE `merchants` SET `name_hinglish` = upper(`name_hinglish`) WHERE `name_hinglish` IS NOT NULL AND `name_hinglish` <> upper(`name_hinglish`);
