// Creates a contact through the Contacts app, so iCloud sync stays intact.
// Never writes to the Contacts database file directly.
import { execFile } from 'node:child_process';

const ADD = `
on run argv
  set firstName to item 1 of argv
  set lastName to item 2 of argv
  set handleValue to item 3 of argv
  set handleKind to item 4 of argv
  tell application "Contacts"
    set p to make new person with properties {first name:firstName, last name:lastName}
    if handleKind is "phone" then
      make new phone at end of phones of p with properties {label:"mobile", value:handleValue}
    else
      make new email at end of emails of p with properties {label:"home", value:handleValue}
    end if
    save
    return id of p
  end tell
end run`;

const REMOVE = `
on run argv
  tell application "Contacts"
    delete (first person whose id is (item 1 of argv))
    save
  end tell
  return "deleted"
end run`;

function osa(script, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/osascript', ['-', ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout).trim());
      const msg = String(stderr || err.message || '').trim();
      if (/-1743|not authori[sz]ed|Not allowed to send Apple events/i.test(msg)) {
        return reject(new Error('This terminal is not allowed to control Contacts. Fix: System Settings, Privacy & Security, Automation, enable Contacts for your terminal app.'));
      }
      if (err.killed) return reject(new Error('Contacts did not answer in time. A permission prompt may be waiting on screen.'));
      reject(new Error(msg.split('\n').pop() || 'Contacts refused the request.'));
    });
    child.stdin.end(script);
  });
}

export const addContact = ({ first, last = '', handle, kind }) => osa(ADD, [first, last, handle, kind]);
export const removeContact = (id) => osa(REMOVE, [id]);
