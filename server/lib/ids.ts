import { uuidv7 } from "uuidv7";
/** UUIDv7 everywhere: time-sortable, and local rows can never collide with cloud rows. */
export const newId = () => uuidv7();
export const nowSec = () => Math.floor(Date.now() / 1000);
