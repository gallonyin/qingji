import { buildApp } from "./app.js";
import {loadEnvFile} from "node:process";
import {fileURLToPath} from "node:url";
try{loadEnvFile(fileURLToPath(new URL("../../../.env",import.meta.url)));}
catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}

const port = Number(process.env.MYNOTE_PORT ?? process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const app = await buildApp();

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>{
  void app.close().then(()=>process.exit(0)).catch(error=>{app.log.error(error);process.exit(1);});
});
