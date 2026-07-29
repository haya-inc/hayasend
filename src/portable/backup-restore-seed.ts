import {
  reportPortableBackupRestoreFailure,
  runPortableBackupRestoreSeedProcess,
} from "./backup-restore-proof.js";

runPortableBackupRestoreSeedProcess().catch(reportPortableBackupRestoreFailure);
