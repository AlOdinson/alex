const PARTICIPANT_NAME_KEY = 'alex-board:participant-name';
let unsavedName;

function normalizeName(value) {
  return String(value ?? '').trim().slice(0, 40);
}

function readStorage(storage, key) {
  try {
    return window[storage].getItem(key);
  } catch {
    return null;
  }
}

export function saveParticipantName(value) {
  const name = normalizeName(value);
  try {
    // Keep the empty value: deleting the key would revive an old migrated name.
    window.localStorage.setItem(PARTICIPANT_NAME_KEY, name);
    unsavedName = undefined;
  } catch {
    unsavedName = name;
  }
  return name;
}

export function getParticipantName(boardId) {
  if (unsavedName !== undefined) return unsavedName;
  const current = readStorage('localStorage', PARTICIPANT_NAME_KEY);
  if (current !== null) return normalizeName(current);
  const legacyName = normalizeName(readStorage('localStorage', 'alex-board:owner-name'))
    || (boardId ? normalizeName(readStorage('sessionStorage', `alex-board:name:${boardId}`)) : '');
  return legacyName ? saveParticipantName(legacyName) : '';
}
