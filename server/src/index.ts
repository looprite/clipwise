import "dotenv/config";
import { buildApp } from "./app.js";

const { app } = await buildApp();

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`Clipwise server listening on port ${port}`);
});
