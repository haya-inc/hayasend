import {
  reportPortableBackupRestoreFailure,
  runPortableBackupRestoreVerifyProcess,
} from "./backup-restore-proof.js";

runPortableBackupRestoreVerifyProcess().catch(
  reportPortableBackupRestoreFailure,
);
