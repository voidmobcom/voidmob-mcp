import { z } from "zod";

// Input schemas for the opaque ids the API issues. The prefix routes the call;
// the charset (the API's own id alphabet) rules out "." / ".." path segments,
// which URL encoding alone cannot neutralize.
const BODY = "[A-Za-z0-9_-]{1,64}";

const idSchema = (pattern: string, expected: string) =>
  z.string().regex(new RegExp(`^(?:${pattern})$`), `Expected ${expected}`);

export const VerificationOrRentalId = idSchema(`(?:ver|ren)_${BODY}`, "a ver_... or ren_... id");
export const VerificationId = idSchema(`ver_${BODY}`, "a ver_... id");
export const RentalId = idSchema(`ren_${BODY}`, "a ren_... id");
export const RentalOrDedicatedId = idSchema(`(?:ren|ded)_${BODY}`, "a ren_... or ded_... id");
export const DedicatedId = idSchema(`ded_${BODY}`, "a ded_... id");
export const ServiceId = idSchema(`svc_${BODY}`, "a svc_... id from search_sms_services");
export const EsimId = idSchema(`esim_${BODY}`, "an esim_... id");
export const EsimProductId = idSchema(`prod_${BODY}`, "a prod_... id");
export const ProxyPlanId = idSchema(`plan_${BODY}`, "a plan_... id from search_proxies");
// prx_<id>, or a legacy dashboard reference like PRX08781M (still accepted by the API).
export const ProxyId = idSchema(`prx_${BODY}|PRX[A-Za-z0-9]{1,32}`, "a prx_... id");
export const ProxyListId = idSchema(`list_${BODY}`, "a list_... id from list_proxy_lists");
