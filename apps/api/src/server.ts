import { AutomationScheduler } from "./application/automation/scheduler.js";
import { googleGmail } from "./infrastructure/google/gmail.js";
import { googleCalendar } from "./infrastructure/google/calendar.js";
import { discordRuntime } from "./infrastructure/discord/controller.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { purgeExpiredContent } from "./infrastructure/persistence/retention.js";
import { db } from "./infrastructure/persistence/db.js";
const config = loadConfig(process.env);
await purgeExpiredContent(new Date());
const discord = discordRuntime(config);
const automationScheduler = new AutomationScheduler({
  gmail: googleGmail(config),
  calendar: googleCalendar(config),
  allowWrites: config.AUTOMATION_LIVE_WRITES_ENABLED === true,
});
const server = createApp({ config, discord, automationScheduler }).listen(
  config.PORT,
  "127.0.0.1",
  () =>
    console.log(JSON.stringify({ event: "server_started", port: config.PORT })),
);
server.requestTimeout = 30000;
void discord?.start();
automationScheduler.start();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.close(() => {
      Promise.all([
        discord?.stop() || Promise.resolve(),
        automationScheduler.stop(),
      ]).finally(() => db.$disconnect().finally(() => process.exit(0)));
    });
  });
