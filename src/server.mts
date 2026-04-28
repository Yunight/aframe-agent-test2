import { join } from 'node:path';
import Express, { static as serveStatic } from 'express';

const port = 3000;
const app = Express();

app.use(serveStatic(join(import.meta.dirname, '../output')));

app.listen(port, err => {
  if (err instanceof Error) {
    console.error(`[EXCEPTION] ${err.name}:${err.message}\n${err.stack ?? ''}`);
    return process.exit(1);
  }

  console.log(`Server listening on port ${port} ...`);  
});
