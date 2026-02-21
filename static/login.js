(function(){
  const qs = new URLSearchParams(location.search);
  const next = qs.get('next') || '/app';

  const tabLogin = document.getElementById('tabLogin');
  const tabRegister = document.getElementById('tabRegister');
  const submitBtn = document.getElementById('submit');
  const form = document.getElementById('form');
  const msg = document.getElementById('msg');

  let mode = 'login';

  function setMode(m){
    mode = m;
    tabLogin.classList.toggle('active', mode==='login');
    tabRegister.classList.toggle('active', mode==='register');
    submitBtn.textContent = (mode==='login') ? 'Login' : 'Create account';
    msg.textContent = '';
  }
  tabLogin.addEventListener('click', ()=>setMode('login'));
  tabRegister.addEventListener('click', ()=>setMode('register'));

  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    msg.textContent = '';
    submitBtn.disabled = true;

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    try{
      const url = (mode==='login') ? '/api/auth/login' : '/api/auth/register';
      const res = await fetch(url, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({username, password})
      });

      const data = await res.json().catch(()=>({}));
      if(!res.ok){
        msg.textContent = data.detail || 'Something went sideways.';
        submitBtn.disabled = false;
        return;
      }
      location.href = next;
    }catch(err){
      msg.textContent = 'Network error. Try again.';
      submitBtn.disabled = false;
    }
  });

  setMode('login');
})();