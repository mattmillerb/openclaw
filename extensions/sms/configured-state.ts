import { DEFAULT_ACCOUNT_ID, hasConfiguredAccountValue } from "openclaw/plugin-sdk/account-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SmsChannelConfig } from "./src/types.js";

type SmsConfiguredAccount = SmsChannelConfig;

function hasConfiguredSmsAccountState(
  config: SmsConfiguredAccount | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  const hasAccountSid = hasConfiguredAccountValue(config?.accountSid ?? env.TWILIO_ACCOUNT_SID);
  const hasAuthToken = hasConfiguredAccountValue(config?.authToken ?? env.TWILIO_AUTH_TOKEN);
  const envFromNumber = [env.TWILIO_PHONE_NUMBER, env.TWILIO_SMS_FROM].find((value) =>
    hasConfiguredAccountValue(value),
  );
  const hasSender =
    hasConfiguredAccountValue(config?.fromNumber ?? envFromNumber) ||
    hasConfiguredAccountValue(config?.messagingServiceSid ?? env.TWILIO_MESSAGING_SERVICE_SID);
  // Outbound Twilio delivery requires credentials and a sender; webhook
  // signature readiness belongs only to the inbound gateway.
  return hasAccountSid && hasAuthToken && hasSender;
}

/** Match outbound SMS credentials, senders, and account-owned env fallbacks. */
export function hasConfiguredSmsChannelState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const config = params.cfg.channels?.sms as SmsChannelConfig | undefined;
  if (config?.enabled === false) {
    return false;
  }
  const env = params.env ?? process.env;
  const defaultAccount = config?.accounts?.[DEFAULT_ACCOUNT_ID];
  if (defaultAccount?.enabled !== false) {
    const {
      accounts: _accounts,
      defaultAccount: _defaultAccount,
      ...channelDefaults
    } = config ?? {};
    const defaultConfig = defaultAccount ? { ...channelDefaults, ...defaultAccount } : config;
    if (hasConfiguredSmsAccountState(defaultConfig, env)) {
      return true;
    }
  }

  return Object.entries(config?.accounts ?? {}).some(([accountId, account]) => {
    if (accountId === DEFAULT_ACCOUNT_ID || account.enabled === false) {
      return false;
    }
    const {
      accounts: _accounts,
      defaultAccount: _defaultAccount,
      ...channelDefaults
    } = config ?? {};
    const merged = { ...channelDefaults, ...account };
    // Twilio environment credentials are restricted to the default account.
    return hasConfiguredSmsAccountState(merged, {});
  });
}
