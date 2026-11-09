/**
 * Start command helper for KhatamRouter CLI.
 *
 * Exposes launcher process controls and start configurations.
 */

const {
  getPidFilePath,
  writePidRecord,
  readPidRecord,
  removePidRecordIfOwner,
  stopRecordedInstance,
  isPortInUse,
  waitForPortFree,
  waitForPidsExit,
} = require("../utils/launcherProcess");

module.exports = {
  getPidFilePath,
  writePidRecord,
  readPidRecord,
  removePidRecordIfOwner,
  stopRecordedInstance,
  isPortInUse,
  waitForPortFree,
  waitForPidsExit,
};
