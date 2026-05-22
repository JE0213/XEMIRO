(function () {
  if (window.XemiroChatbotLoaded) return;
  window.XemiroChatbotLoaded = true;

  var state = {
    open: false,
    loading: false,
    kb: null,
  };

  var suggestions = [
    '연차 어떻게 신청해?',
    'ERP 어떻게 접속해?',
    '영상 포맷 기준 알려줘',
    '스토리보드 기본 구성이 뭐야?',
    '와이파이 비번 뭐야?',
  ];
  var characterSrc = 'assets/xemiro-chatbot.png';

  function injectStyles() {
    var style = document.createElement('style');
    style.textContent = [
      '.xemi-chatbot{position:fixed;right:24px;bottom:24px;z-index:9999;font-family:inherit;color:#1e1b18}',
      '.xemi-chatbot *{box-sizing:border-box}',
      '.xemi-chatbot__button{width:68px;height:68px;border:0;border-radius:22px;background:#fff;color:#94442e;box-shadow:0 18px 40px rgba(56,31,24,.24);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform .18s ease,box-shadow .18s ease;border:1px solid #eaded2;overflow:hidden;padding:4px}',
      '.xemi-chatbot__button:hover{transform:translateY(-2px);box-shadow:0 20px 44px rgba(56,31,24,.3)}',
      '.xemi-chatbot__button img{width:100%;height:100%;object-fit:contain;display:block}',
      '.xemi-chatbot__panel{position:absolute;right:0;bottom:76px;width:min(380px,calc(100vw - 32px));height:min(620px,calc(100vh - 120px));background:#fff;border:1px solid #e8ded1;border-radius:18px;box-shadow:0 24px 70px rgba(33,21,17,.22);overflow:hidden;display:none;flex-direction:column}',
      '.xemi-chatbot.is-open .xemi-chatbot__panel{display:flex}',
      '.xemi-chatbot__head{padding:18px 18px 14px;background:#fbf8f3;border-bottom:1px solid #e8ded1;display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.xemi-chatbot__brand{display:flex;align-items:center;gap:12px;min-width:0}',
      '.xemi-chatbot__avatar{width:48px;height:48px;border-radius:16px;background:#fff;border:1px solid #eaded2;object-fit:contain;padding:3px;box-shadow:0 8px 18px rgba(56,31,24,.12);flex:0 0 auto}',
      '.xemi-chatbot__title{font-weight:800;font-size:16px;letter-spacing:0;color:#2f2723}',
      '.xemi-chatbot__sub{font-size:12px;color:#77645d;margin-top:3px;line-height:1.4}',
      '.xemi-chatbot__close{border:0;background:transparent;color:#77645d;width:34px;height:34px;border-radius:10px;cursor:pointer;display:flex;align-items:center;justify-content:center}',
      '.xemi-chatbot__close:hover{background:#efe6dc;color:#2f2723}',
      '.xemi-chatbot__messages{flex:1;overflow:auto;padding:18px;background:linear-gradient(180deg,#fff 0%,#fffaf5 100%)}',
      '.xemi-chatbot__msg{max-width:92%;border-radius:16px;padding:12px 14px;margin-bottom:12px;font-size:13px;line-height:1.65}',
      '.xemi-chatbot__msg--bot{background:#f5efe8;border:1px solid #eaded2;color:#2f2723;border-bottom-left-radius:6px}',
      '.xemi-chatbot__msg--user{background:#94442e;color:#fff;margin-left:auto;border-bottom-right-radius:6px}',
      '.xemi-chatbot__msg a{color:#94442e;font-weight:700;text-decoration:none}',
      '.xemi-chatbot__msg a:hover{text-decoration:underline}',
      '.xemi-chatbot__hello{display:flex;align-items:flex-start;gap:10px}',
      '.xemi-chatbot__hello img{width:58px;height:58px;object-fit:contain;flex:0 0 auto;margin-top:-4px}',
      '.xemi-chatbot__hello-text{min-width:0}',
      '.xemi-chatbot__source{margin-top:10px;padding-top:10px;border-top:1px solid rgba(148,68,46,.16);font-size:12px;color:#77645d}',
      '.xemi-chatbot__suggestions{display:flex;flex-wrap:wrap;gap:7px;margin:4px 0 14px}',
      '.xemi-chatbot__chip{border:1px solid #e1d3c6;background:#fff;color:#6a5148;border-radius:999px;padding:7px 10px;font-size:12px;cursor:pointer}',
      '.xemi-chatbot__chip:hover{border-color:#94442e;color:#94442e}',
      '.xemi-chatbot__form{border-top:1px solid #e8ded1;background:#fff;padding:12px;display:flex;gap:8px}',
      '.xemi-chatbot__input{flex:1;min-width:0;border:1px solid #d8c8ba;border-radius:12px;padding:11px 12px;font:inherit;font-size:13px;outline:none}',
      '.xemi-chatbot__input:focus{border-color:#94442e;box-shadow:0 0 0 3px rgba(148,68,46,.12)}',
      '.xemi-chatbot__send{width:44px;border:0;border-radius:12px;background:#94442e;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center}',
      '.xemi-chatbot__send:hover{background:#7e3928}',
      '.xemi-chatbot .wstag{display:inline-flex;margin-bottom:6px;color:#94442e;font-weight:800}',
      '@media (max-width:640px){.xemi-chatbot{right:16px;bottom:16px}.xemi-chatbot__panel{right:-4px;bottom:72px;width:calc(100vw - 24px);height:min(620px,calc(100vh - 104px))}}',
    ].join('');
    document.head.appendChild(style);
  }

  function createWidget() {
    var root = document.createElement('div');
    root.className = 'xemi-chatbot';
    root.innerHTML =
      '<section class="xemi-chatbot__panel" aria-label="XEMIRO 위키 챗봇">' +
        '<header class="xemi-chatbot__head">' +
          '<div class="xemi-chatbot__brand"><img class="xemi-chatbot__avatar" src="' + characterSrc + '" alt=""><div><div class="xemi-chatbot__title">XEMIRO Wiki Bot</div><div class="xemi-chatbot__sub">사내 위키에서 필요한 내용을 찾아드릴게요.</div></div></div>' +
          '<button class="xemi-chatbot__close" type="button" aria-label="닫기"><span class="material-symbols-outlined">close</span></button>' +
        '</header>' +
        '<div class="xemi-chatbot__messages" role="log" aria-live="polite"></div>' +
        '<form class="xemi-chatbot__form">' +
          '<input class="xemi-chatbot__input" type="text" placeholder="질문을 입력하세요" autocomplete="off">' +
          '<button class="xemi-chatbot__send" type="submit" aria-label="보내기"><span class="material-symbols-outlined">send</span></button>' +
        '</form>' +
      '</section>' +
      '<button class="xemi-chatbot__button" type="button" aria-label="위키 챗봇 열기"><img src="' + characterSrc + '" alt=""></button>';

    document.body.appendChild(root);

    var button = root.querySelector('.xemi-chatbot__button');
    var close = root.querySelector('.xemi-chatbot__close');
    var form = root.querySelector('.xemi-chatbot__form');
    var input = root.querySelector('.xemi-chatbot__input');
    var messages = root.querySelector('.xemi-chatbot__messages');

    function setOpen(next) {
      state.open = next;
      root.classList.toggle('is-open', next);
      if (next) {
        if (!messages.children.length) renderIntro(messages);
        setTimeout(function () { input.focus(); }, 50);
      }
    }

    button.addEventListener('click', function () { setOpen(!state.open); });
    close.addEventListener('click', function () { setOpen(false); });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var query = input.value.trim();
      if (!query) return;
      input.value = '';
      ask(query, messages);
    });
  }

  function renderIntro(messages) {
    addMessage(messages, 'bot',
      '<div class="xemi-chatbot__hello"><img src="' + characterSrc + '" alt=""><div class="xemi-chatbot__hello-text">궁금한 내용을 짧게 물어보세요. 지금은 위키에 등록된 기준, 절차, 사내 가이드 중심으로 답변해요.</div></div>' +
      '<div class="xemi-chatbot__suggestions">' +
      suggestions.map(function (text) {
        return '<button class="xemi-chatbot__chip" type="button" data-chat-question="' + escapeHtml(text) + '">' + escapeHtml(text) + '</button>';
      }).join('') +
      '</div>'
    );
    messages.querySelectorAll('[data-chat-question]').forEach(function (chip) {
      chip.addEventListener('click', function () { ask(chip.getAttribute('data-chat-question'), messages); });
    });
  }

  function addMessage(messages, type, html) {
    var node = document.createElement('div');
    node.className = 'xemi-chatbot__msg xemi-chatbot__msg--' + type;
    node.innerHTML = html;
    messages.appendChild(node);
    messages.scrollTop = messages.scrollHeight;
    return node;
  }

  async function ask(query, messages) {
    addMessage(messages, 'user', escapeHtml(query));
    var thinking = addMessage(messages, 'bot', '위키에서 찾아보는 중입니다...');
    try {
      var result = findAnswer(query, await loadKnowledgeBase());
      thinking.innerHTML = result.html;
    } catch (error) {
      thinking.innerHTML = '위키 데이터를 불러오지 못했어요. 잠시 후 다시 시도하거나 위키 페이지에서 직접 검색해 주세요.';
      console.warn('XEMIRO chatbot error:', error);
    }
    messages.scrollTop = messages.scrollHeight;
  }

  async function loadKnowledgeBase() {
    if (state.kb) return state.kb;
    if (window.KB && Array.isArray(window.KB)) {
      state.kb = window.KB;
      return state.kb;
    }
    var res = await fetch('wiki.html', { cache: 'no-cache' });
    var html = await res.text();
    var match = html.match(/const\s+KB\s*=\s*(\[[\s\S]*?\]);\s*let\s+curCat/);
    if (!match) throw new Error('KB not found');
    state.kb = Function('"use strict"; return (' + match[1] + ');')();
    return state.kb;
  }

  function findAnswer(query, kb) {
    var low = normalize(query);
    var best = null;
    var bestScore = 0;
    kb.forEach(function (item) {
      var score = 0;
      (item.keys || []).forEach(function (key) {
        var normalizedKey = normalize(key);
        if (!normalizedKey) return;
        if (low.includes(normalizedKey)) score += normalizedKey.length * 2;
        else if (normalizedKey.includes(low)) score += Math.min(low.length, normalizedKey.length);
      });
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    });
    if (best && bestScore > 0) {
      return {
        html: best.ans + '<div class="xemi-chatbot__source">출처: ' + escapeHtml(best.src || '위키') + '</div>',
      };
    }
    var wikiUrl = 'wiki.html?q=' + encodeURIComponent(query);
    return {
      html: '위키에서 바로 맞는 답을 찾지는 못했어요. 검색 결과로 이어서 확인해볼 수 있습니다.' +
        '<div class="xemi-chatbot__source"><a href="' + wikiUrl + '">위키에서 검색하기</a></div>',
    };
  }

  function normalize(text) {
    return String(text || '').toLowerCase().replace(/\s/g, '');
  }

  function escapeHtml(text) {
    return String(text || '').replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  if (!window.calcLeave) {
    window.calcLeave = function () {
      var input = document.getElementById('join-date');
      var result = document.getElementById('leave-result');
      if (!input || !result || !input.value) return;
      var join = new Date(input.value + 'T00:00:00');
      var now = new Date();
      var months = (now.getFullYear() - join.getFullYear()) * 12 + now.getMonth() - join.getMonth();
      var years = now.getFullYear() - join.getFullYear();
      var days = years < 1 ? Math.max(0, Math.min(11, months)) : 15;
      result.innerHTML = '대략 <strong>' + days + '일</strong> 기준으로 확인해보세요. 정확한 잔여일수는 ERP 휴가잔여일수현황에서 최종 확인이 필요합니다.';
    };
  }

  document.addEventListener('DOMContentLoaded', function () {
    injectStyles();
    createWidget();
  });
})();
