import { uuidv7 } from "uuidv7";
/** UUIDv7 everywhere: time-sortable, and local rows can never collide with cloud rows.
 *  (A scanned sheet's slips are the one exception: their ids come from the sheet and the line, lib/sheetSlips.ts.) */
export const newId = () => uuidv7();
export const nowSec = () => Math.floor(Date.now() / 1000);
