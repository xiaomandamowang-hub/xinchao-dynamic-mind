export const STATE_PUBLICATION_PROFILE_PRIVATE = 'private';
export const STATE_PUBLICATION_PROFILE_CONTROLLED_READER_V1 = 'controlled-reader-v1';

const PROFILES = Object.freeze({
  [STATE_PUBLICATION_PROFILE_PRIVATE]: Object.freeze({
    profile: STATE_PUBLICATION_PROFILE_PRIVATE,
    tempFileMode: 0o600,
    finalFileMode: 0o600,
    applyFinalModeAfterWrite: false,
    requiresDedicatedDirectory: false,
  }),
  [STATE_PUBLICATION_PROFILE_CONTROLLED_READER_V1]: Object.freeze({
    profile: STATE_PUBLICATION_PROFILE_CONTROLLED_READER_V1,
    tempFileMode: 0o600,
    finalFileMode: 0o640,
    applyFinalModeAfterWrite: true,
    requiresDedicatedDirectory: true,
  }),
});

export function inspectStatePublicationProfile(value = STATE_PUBLICATION_PROFILE_PRIVATE) {
  if (typeof value !== 'string' || !Object.hasOwn(PROFILES, value)) {
    throw new Error('STATE_PUBLICATION_PROFILE must be private or controlled-reader-v1');
  }
  return PROFILES[value];
}
