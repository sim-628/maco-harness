// Scope alternatives are ordered from narrowest to broadest for each provider.
const google = short => 'https://www.googleapis.com/auth/gmail.' + short;
const full = 'https://mail.google.com/';
const modify = [google('modify'), full];
const labels = [google('labels'), ...modify];
const compose = [google('compose'), ...modify];
const send = [google('send'), ...compose];
const read = [google('readonly'), ...modify];
const write = ['Mail.ReadWrite'];
const graphRead = ['Mail.Read', ...write];

export function readOAuthScopes(provider) {
  return provider === 'gmail' ? [...read] : provider === 'outlook' ? [...graphRead] : [];
}

const catalog = new Map();
function actions(names, gmail, outlook) {
  for (const action of names.split(' ')) catalog.set(action, {gmail, outlook});
}
actions('mark_read mark_unread star unstar archive trash restore move_to_inbox', modify, write);
actions('mark_spam mark_not_spam mark_important mark_unimportant', modify, write);
actions('add_label remove_label', modify, null);
actions('create_label rename_label delete_label', labels, null);
actions('move create_folder rename_folder set_categories', null, write);
actions('create_draft update_draft delete_draft', compose, write);
actions('add_draft_attachment remove_draft_attachment', null, write);
actions('send reply forward', send, ['Mail.Send']);
export const ACTIONS = [...catalog.keys()];

export function fault(code, message = code) {
  return Object.assign(new Error(message), {code});
}

export function hasScope(credential, alternatives) {
  // Microsoft sign-in can return resource-qualified scopes.
  const granted = new Set((credential.scopes || []).map(s => String(s).replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase()));
  return alternatives.some(s => granted.has(s.toLowerCase()));
}

export function mailCapabilities(credential) {
  return ACTIONS.map(action => {
    const requiredScopes = catalog.get(action)[credential.provider] || [];
    const additionalRequiredScopes = [];
    if (action==='reply' || action==='forward' || action==='add_draft_attachment' || action==='remove_draft_attachment') {
      additionalRequiredScopes.push(readOAuthScopes(credential.provider));
    } else if (action==='send' && credential.provider==='gmail') {
      // Sending alone cannot fetch the authenticated From address.
      additionalRequiredScopes.push([google('metadata'),google('readonly'),...compose]);
    }
    const authorized = hasScope(credential,requiredScopes) && additionalRequiredScopes.every(group=>hasScope(credential,group));
    return {action, supported: requiredScopes.length > 0, authorized, requiredScopes: [...requiredScopes], additionalRequiredScopes};
  });
}

export function checkAction(credential, action) {
  const capability = mailCapabilities(credential).find(entry => entry.action === action);
  if (!capability?.supported) throw fault('unsupported_action');
  if (!capability.authorized) throw fault('scope_required');
  if (!Array.isArray(credential.actions) || !credential.actions.includes(action)) throw fault('action_forbidden');
}

export function checkRead(credential) {
  if (!hasScope(credential, readOAuthScopes(credential.provider))) throw fault('scope_required');
}

export const approvalActions = new Set(['send','reply','forward','delete_draft','delete_label','remove_draft_attachment']);
