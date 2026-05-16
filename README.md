# Name Voter

`Name Voter` is a static single-page app for collaboratively choosing a company name. It is designed to deploy on GitHub Pages, with two operating modes:

- `Demo mode`: no setup required, data is stored in the current browser with `localStorage`.
- `Shared mode`: configure Firebase Firestore and everybody using the same room link will see the same live data.

There is also a spreadsheet alternative described in [SPREADSHEET.md](/home/hlaw/src/name-voter/SPREADSHEET.md:1).

## Features

- Username-based trust model with no authentication
- Username is stored per browser tab/session, so separate normal tabs can act as different users in demo mode
- Shared list of candidate names with notes
- Per-candidate comments tagged with the commenter username
- One ballot per username, editable only from that username's session in the UI
- Yes or no approval voting for every candidate
- At most `10` approvals per person
- Separate approved and not-approved views for every ballot
- Live aggregate results showing the top `5` names by approval count

## Local preview

Because the app uses ES modules, serve the directory over HTTP instead of opening `index.html` directly:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

## Deploy To GitHub Pages

1. Put these files in a GitHub repository.
2. In the repository settings, open `Pages`.
3. Set the source to `Deploy from a branch`.
4. Pick your default branch and `/ (root)` as the folder.
5. Save, then wait for the Pages URL to appear.
6. Add an empty file named `.nojekyll` at the repo root if you want to make sure GitHub Pages serves the site without Jekyll processing.

## Configure Shared Live Data With Firebase

GitHub Pages cannot run a server, so shared multi-user data needs a hosted datastore. This app is already wired for Firebase Firestore.

1. Create a Firebase project.
2. In that project, create a `Firestore Database` in production or test mode.
3. In `Project settings`, create a Web App.
4. Copy the Firebase config object into `firebase-config.js`, replacing the default `null`.

Example:

```js
window.NAME_VOTER_FIREBASE_CONFIG = {
  apiKey: "your-api-key",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.firebasestorage.app",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef123456",
};
```

5. Publish the updated files to GitHub Pages.

## Firestore Rules

This app is intentionally based on trust, not strong authentication. The simplest deployment is to allow reads and writes inside the `rooms` collection. Anyone with your site URL and a room token can access the room, so share links carefully.

Example rules:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read, write: if true;
    }
    match /rooms/{roomId}/{document=**} {
      allow read, write: if true;
    }
  }
}
```

If you need stronger privacy than a secret link, GitHub Pages plus unauthenticated Firestore is the wrong deployment model. You would need actual authentication and stricter database rules.

## Secret Link Usage

- The secret link is the full URL including the `?room=...` token.
- Creating a room generates a random 24-character token.
- Share that exact link only with the people who should participate.
- This is `security by unguessable URL`, not hardened access control.

## Notes On Vote Counting

- Each person can approve a name or leave it not approved.
- Not approved is treated as a no vote.
- Each person can approve at most `10` names.
- The results page lists the top `5` names by approval count.
