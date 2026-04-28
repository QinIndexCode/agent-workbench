import { createBackendNewFoundation } from '../foundation/bootstrap/create-foundation';
import { runBackendNewMigrations } from '../foundation/database/migrate';

async function main(): Promise<void> {
  const foundation = createBackendNewFoundation();
  if (!foundation.database) {
    throw new Error('backend_new migration error: storage.driver=postgres is required.');
  }
  const applied = await runBackendNewMigrations(foundation.config, foundation.database);
  console.log(`backend_new migrations applied: ${applied}`);
  await foundation.database.close();
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
