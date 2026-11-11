# notice/

- `recording-notice-v<N>.txt` is the full member notice, version N. `recording-notice-v<N>-ack.txt` is the short notice for the same version, the one members agree to with "I understand" (from v2 on). `voice-prints-statement-v<N>.txt` is the Recognize voices statement, version N.
- Versions only go up. Old files stay as the record of what members agreed to, so never delete or edit them.
- A wording change means a new file at the next version and a version bump in code: `STATEMENT_VERSION` and `NOTICE_UPDATED` in `consent.js` for the notice, `STATEMENT_VERSION` in `voice-prints.js` for the statement.
- The notice and the statement are versioned separately but must say the same thing about voice prints. Change one, check the other.
