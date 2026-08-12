
// ===== Urban Farms Language Enhancements =====
(function(){
// Only English, Telugu, Hindi supported
const LANG_MAP={en:'en',te:'te',hi:'hi'};
const LANG_LABEL={en:'EN',te:'తెలుగు',hi:'हिंदी'};
const SUPPORTED_LANGS=['en','te','hi'];

function initGoogleTranslate(){
  if(window.google&&google.translate){
    new google.translate.TranslateElement({
      pageLanguage:'en',
      includedLanguages:'en,te,hi',
      autoDisplay:false,
      multilanguagePage:true
    },'google_translate_element');
    const saved = localStorage.getItem('uf_lang') || 'en';
    // Keep trying to set the combo until it's available
    function retrySetCombo() {
      if (!trySetCombo(saved)) {
        setTimeout(retrySetCombo, 400);
      }
    }
    setTimeout(retrySetCombo, 600);
  }
}
window.googleTranslateElementInit=initGoogleTranslate;

function setTranslatorLabel(lang){
  const label=document.querySelector('.translator-label');
  if(label) label.textContent = LANG_LABEL[lang] || 'EN';
}
function applyLangButtons(lang){
  document.querySelectorAll('.lang-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.lang===lang);
  });
  setTranslatorLabel(lang);
}
function trySetCombo(lang){
  const combo=document.querySelector('.goog-te-combo');
  if(!combo) return false;
  // Only allow supported languages
  const safeLang = SUPPORTED_LANGS.includes(lang) ? lang : 'en';
  combo.value = LANG_MAP[safeLang] || 'en';
  combo.dispatchEvent(new Event('change'));
  applyLangButtons(safeLang);
  return true;
}
function closeTranslatorMenu(){
  const menu=document.getElementById('translatorMenu');
  const toggle=document.getElementById('translatorToggle');
  if(menu&&menu.classList.contains('open')){
    menu.classList.remove('open');
    if(toggle) toggle.setAttribute('aria-expanded','false');
  }
}
function toggleTranslatorMenu(){
  const menu=document.getElementById('translatorMenu');
  const toggle=document.getElementById('translatorToggle');
  if(!menu||!toggle) return;
  const open=!menu.classList.contains('open');
  menu.classList.toggle('open',open);
  toggle.setAttribute('aria-expanded',String(open));
}
function setLang(lang){
  // Only allow supported languages
  const safeLang = SUPPORTED_LANGS.includes(lang) ? lang : 'en';
  localStorage.setItem('uf_lang', safeLang);
  applyLangButtons(safeLang);
  closeTranslatorMenu();
  if(!trySetCombo(safeLang)){
    setTimeout(()=>trySetCombo(safeLang), 400);
  }
}
window.addEventListener('load',()=>{
  const saved=localStorage.getItem('uf_lang')||'en';
  const safeLang = SUPPORTED_LANGS.includes(saved) ? saved : 'en';
  applyLangButtons(safeLang);
  setTranslatorLabel(safeLang);
  document.querySelectorAll('.lang-btn').forEach(btn=>{
    btn.addEventListener('click',()=>setLang(btn.dataset.lang));
  });
  const toggle=document.getElementById('translatorToggle');
  if(toggle){
    toggle.addEventListener('click',event=>{
      event.stopPropagation();
      toggleTranslatorMenu();
    });
  }
  document.addEventListener('click',event=>{
    const wrapper=document.querySelector('.translator-wrapper');
    if(wrapper&&!wrapper.contains(event.target)){
      closeTranslatorMenu();
    }
  });
  if(!trySetCombo(safeLang)){
    setTimeout(()=>trySetCombo(safeLang), 400);
  }
});
})();
