import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeRedis } from "./helpers/redisMock.js";
import {
  setRedisClient,
  setRedisSubscriber,
  closeRedisClient,
} from "@/lib/redis/client.js";
import {
  publishKhatamEvent,
  subscribeKhatamEvent,
  KHATAM_EVENTS,
} from "@/lib/redis/events.js";

describe("US7 Scenario 6: PubSub Subscriber Connection Isolation", () => {
  let commandClient;
  let subscriberClient;

  beforeEach(() => {
    FakeRedis.clearAll();
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.REDIS_KEY_PREFIX = "khatam:";

    commandClient = new FakeRedis();
    subscriberClient = new FakeRedis();

    setRedisClient(commandClient);
    setRedisSubscriber(subscriberClient);
  });

  afterEach(() => {
    closeRedisClient();
    delete process.env.REDIS_URL;
    delete process.env.REDIS_KEY_PREFIX;
  });

  it("defines USAGE and CONSOLE_LOG in KHATAM_EVENTS", () => {
    expect(KHATAM_EVENTS.USAGE).toBe("khatam:events:usage");
    expect(KHATAM_EVENTS.CONSOLE_LOG).toBe("khatam:events:console_log");
  });

  it("publishes via command client, not throwing when subscriber is in subscriber mode", async () => {
    // 1. Subscribe on channel, putting subscriberClient into subscriber mode
    const unsub = subscribeKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, () => {});

    // Verify subscriber is in subscriber mode
    expect(subscriberClient.inSubscriberMode).toBe(true);

    // 2. Publish an event. If publish goes over subscriberClient, it will throw/fail
    // because subscriber connections reject publish in RESP2/RESP3.
    // It must route through commandClient!
    const publishSpy = vi.spyOn(commandClient, "publish");

    const result = publishKhatamEvent(KHATAM_EVENTS.CONFIG_RELOAD, { reloaded: true });

    expect(result).toBe(true);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledWith(
      KHATAM_EVENTS.CONFIG_RELOAD,
      expect.stringContaining('"reloaded":true')
    );

    unsub();
  });
});
