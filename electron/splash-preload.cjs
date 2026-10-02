/* The splash's two buttons when start-up goes wrong: Try again (or, after an
 * update that could not open the books, Go back to the kept version) and Close.
 * Nothing else of the app is reachable from the splash. */
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mandi", {
  tryAgain: () => ipcRenderer.send("mandi:try-again"),
  close: () => ipcRenderer.send("mandi:close"),
});
