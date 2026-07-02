export const VER_PREFIX = "ver_";
export const REN_PREFIX = "ren_";
export const DED_PREFIX = "ded_";

export const isVerificationId = (id: string): boolean => id.startsWith(VER_PREFIX);
export const isRentalId = (id: string): boolean => id.startsWith(REN_PREFIX);
export const isDedicatedId = (id: string): boolean => id.startsWith(DED_PREFIX);

export const INVALID_RENTAL_ID = (id: string): string =>
  `Invalid rental_id '${id}'. Expected ${VER_PREFIX}xxx (verification) or ${REN_PREFIX}xxx (long-term/dedicated).`;
