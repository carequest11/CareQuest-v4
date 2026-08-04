// Shared header auth-state widget — runs on every CareQuest page.
// Requires js/supabaseClient.js (the `cq` client) to already be loaded,
// and an empty <div id="authSlot"></div> somewhere in the header.
//
// Signed out: shows a large, high-contrast "Log In" button.
// Signed in: shows the member's first name (linking to member)
// and a "Log Out" button. Reacts live to auth state changes so a page
// left open across a login/logout elsewhere stays in sync.
(function () {
  function renderSignedOut(slot) {
    slot.textContent = '';
    const a = document.createElement('a');
    a.href = 'login';
    a.className = 'auth-btn auth-btn-login';
    a.textContent = 'Log In';
    slot.appendChild(a);
  }

  function renderSignedIn(slot, name) {
    slot.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'auth-signed-in';

    const nameLink = document.createElement('a');
    nameLink.href = 'member';
    nameLink.className = 'auth-btn auth-btn-name';
    nameLink.textContent = name;

    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.className = 'auth-btn auth-btn-logout';
    logoutBtn.textContent = 'Log Out';
    logoutBtn.addEventListener('click', async () => {
      await cq.auth.signOut();
      window.location.href = 'index';
    });

    wrap.appendChild(nameLink);
    wrap.appendChild(logoutBtn);
    slot.appendChild(wrap);
  }

  async function getDisplayName(userId) {
    const { data: youthProfile } = await cq
      .from('youth_profiles')
      .select('first_name')
      .eq('id', userId)
      .maybeSingle();
    if (youthProfile) return youthProfile.first_name;

    const { data: seniorProfile } = await cq
      .from('senior_profiles')
      .select('full_name')
      .eq('id', userId)
      .maybeSingle();
    if (seniorProfile) return seniorProfile.full_name.split(' ')[0];

    return 'Member';
  }

  async function refresh(slot, session) {
    if (session) {
      const name = await getDisplayName(session.user.id);
      renderSignedIn(slot, name);
    } else {
      renderSignedOut(slot);
    }
  }

  async function initAuthHeader() {
    const slot = document.getElementById('authSlot');
    if (!slot || typeof cq === 'undefined') return;

    const { data: { session } } = await cq.auth.getSession();
    await refresh(slot, session);

    cq.auth.onAuthStateChange((_event, session) => {
      refresh(slot, session);
    });
  }

  initAuthHeader();
})();
