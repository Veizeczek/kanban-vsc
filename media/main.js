(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // dragMode: null | 'card' | 'column'
  let dragMode         = null;
  let cardDragPath     = null;
  let cardDragStatus   = null;
  let columnDragStatus = null;
  let saveChangesInFlight = false;
  let lastRenderedState = INITIAL_BOARD_STATE;
  let visibility = INITIAL_BOARD_STATE.visibility ?? {};

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function taskSignature(tasks) {
    return JSON.stringify(tasks.map(task => [task.filePath, task.title, task.date, task.status, Boolean(task.pinned)]));
  }

  function currentZoneSignature(zone) {
    return JSON.stringify([...zone.querySelectorAll('.kanban-card')].map(card => [
      card.dataset.filePath,
      card.querySelector('.card-title')?.textContent ?? '',
      card.querySelector('.card-date')?.textContent ?? '',
      card.dataset.status,
      card.classList.contains('is-pinned'),
    ]));
  }

  function copyBtnHtml(relPath) {
    const label = `${escapeHtml(I18N.copyPath)}: ${escapeHtml(relPath)}`;
    return `
      <button class="card-copy-btn"
              type="button"
              draggable="false"
              data-rel-path="${escapeHtml(relPath)}"
              title="${label}"
              aria-label="${escapeHtml(I18N.copyPath)}">
        <span class="material-icon mi-content_copy icon-copy" aria-hidden="true"></span>
        <span class="material-icon mi-check icon-check" aria-hidden="true"></span>
      </button>
    `;
  }

  function attachCopyBtnListener(btn) {
    if (btn.dataset.boundCopy === 'true') { return; }
    btn.dataset.boundCopy = 'true';

    btn.addEventListener('dragstart', e => {
      e.preventDefault();
      e.stopPropagation();
    });

    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const relPath = btn.dataset.relPath;
      if (!relPath) { return; }
      vscode.postMessage({ command: 'copyPath', relPath });
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1200);
    });
  }

  function cardHtml(task) {
    return `
      <div class="kanban-card${task.pinned ? ' is-pinned' : ''}"
           draggable="true"
           data-file-path="${escapeHtml(task.filePath)}"
           data-status="${escapeHtml(task.status)}">
        <div class="card-top">
          <div class="card-title" data-file-path="${escapeHtml(task.filePath)}">${escapeHtml(task.title)}</div>
          <button class="card-pin-btn" type="button" draggable="false"
                  data-file-path="${escapeHtml(task.filePath)}" aria-pressed="${Boolean(task.pinned)}"
                  title="${escapeHtml(task.pinned ? I18N.unpinTask : I18N.pinTask)}"
                  aria-label="${escapeHtml(task.pinned ? I18N.unpinTask : I18N.pinTask)}">
            <span class="material-icon mi-push_pin" aria-hidden="true"></span>
          </button>
          ${copyBtnHtml(task.relPath || '')}
        </div>
        <div class="card-date">${escapeHtml(task.date)}</div>
      </div>
    `;
  }

  function attachCardTitleListener(title) {
    if (title.dataset.boundOpen === 'true') { return; }
    title.dataset.boundOpen = 'true';
    title.addEventListener('click', () => {
      const fp = title.dataset.filePath;
      if (fp) { vscode.postMessage({ command: 'openFile', filePath: fp }); }
    });
  }

  function attachCardListeners(card) {
    if (card.dataset.boundDrag === 'true') { return; }
    card.dataset.boundDrag = 'true';

    card.addEventListener('dragstart', e => {
      e.stopPropagation();           // don't trigger column-header drag
      dragMode       = 'card';
      cardDragPath   = card.dataset.filePath;
      cardDragStatus = card.dataset.status;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      cardDragPath = cardDragStatus = null;
      dragMode = null;
    });

    const title = card.querySelector('.card-title');
    if (title) { attachCardTitleListener(title); }

    const pinBtn = card.querySelector('.card-pin-btn');
    pinBtn?.addEventListener('dragstart', e => { e.preventDefault(); e.stopPropagation(); });
    pinBtn?.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ command: 'setTaskPinned', filePath: pinBtn.dataset.filePath,
        pinned: pinBtn.getAttribute('aria-pressed') !== 'true' });
    });
    const copyBtn = card.querySelector('.card-copy-btn');
    if (copyBtn) { attachCopyBtnListener(copyBtn); }
  }

  function updateHeaderControls(docsExists) {


    const saveChangesBtn = document.getElementById('save-changes-btn');
    if (saveChangesBtn && !saveChangesInFlight) {
      saveChangesBtn.disabled = !docsExists;
    }
  }

  function filterColumn(column) {
    const query = column.querySelector('.column-search').value.trim().toLocaleLowerCase();
    const cards = [...column.querySelectorAll('.kanban-card')];
    let visible = 0;
    cards.forEach(card => {
      const text = `${card.querySelector('.card-title').textContent} ${card.querySelector('.card-copy-btn')?.dataset.relPath ?? ''}`;
      const hidden = Boolean(query) && !text.toLocaleLowerCase().includes(query);
      if (card.hidden !== hidden) { card.hidden = hidden; }
      if (!hidden) { visible++; }
    });
    const count = column.querySelector('.task-count');
    const label = String(visible);
    if (count.textContent !== label) { count.textContent = label; }
    if (count.classList.contains('empty') !== (visible === 0)) { count.classList.toggle('empty', visible === 0); }
    const dot = column.querySelector('.active-dot');
    if (dot && dot.hidden !== (visible === 0)) { dot.hidden = visible === 0; }
    const empty = column.querySelector('.column-search-empty');
    const hideEmpty = !query || visible > 0;
    if (empty.hidden !== hideEmpty) { empty.hidden = hideEmpty; }
  }

  document.querySelectorAll('.column-search').forEach(input => {
    const column = input.closest('.kanban-column');
    const toggle = column.querySelector('.column-search-toggle');
    const title = column.querySelector('.column-title');
    function closeSearch(restoreFocus = false) {
      input.value = '';
      filterColumn(column);
      input.hidden = true;
      title.hidden = false;
      toggle.setAttribute('aria-expanded', 'false');
      if (restoreFocus) { toggle.focus(); }
    }
    toggle.addEventListener('click', () => {
      if (!input.hidden) { closeSearch(true); return; }
      title.hidden = true;
      input.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      input.focus();
    });
    toggle.addEventListener('dragstart', event => {
      event.preventDefault();
      event.stopPropagation();
    });
    input.addEventListener('blur', event => {
      if (!input.value.trim() && !toggle.contains(event.relatedTarget)) { closeSearch(); }
    });
    input.addEventListener('input', () => filterColumn(column));
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSearch(true);
      }
    });
    input.addEventListener('dragstart', event => {
      event.preventDefault();
      event.stopPropagation();
    });
  });

  function updateColumn(status, tasks) {
    const column = document.querySelector(`.kanban-column[data-status="${status}"]`);
    if (!column) { return; }

    const signature = taskSignature(tasks);
    const zone = column.querySelector('.column-cards');
    if (!zone || zone.dataset.signature === signature) { return; }
    const hasItems = tasks.length > 0;
    const count = column.querySelector('.task-count');
    const activeDot = column.querySelector('.active-dot');


    if (count) {
      if (count.textContent !== String(tasks.length)) { count.textContent = String(tasks.length); }
      count.classList.toggle('empty', !hasItems);
    }

    if (count && hasItems && !activeDot) {
      column.querySelector('.col-header-left').insertAdjacentHTML('afterbegin', '<span class="active-dot"></span>');
    } else if (!hasItems && activeDot) {
      activeDot.remove();
    }

    zone.classList.toggle('has-items', hasItems);

    const scrollTop = zone.scrollTop;
    const focused = document.activeElement;
    const cards = new Map([...zone.querySelectorAll('.kanban-card')].map(card => [card.dataset.filePath, card]));
    const desiredPaths = new Set(tasks.map(task => task.filePath));
    for (const [filePath, card] of cards) {
      if (!desiredPaths.has(filePath)) { card.remove(); }
    }
    tasks.forEach((task, index) => {
      let card = cards.get(task.filePath);
      if (!card) {
        const template = document.createElement('template');
        template.innerHTML = cardHtml(task).trim();
        card = template.content.firstElementChild;
        attachCardListeners(card);
      } else {
        const title = card.querySelector('.card-title');
        const date = card.querySelector('.card-date');
        if (title.textContent !== task.title) { title.textContent = task.title; }
        if (date.textContent !== task.date) { date.textContent = task.date; }
        if (card.dataset.status !== task.status) { card.dataset.status = task.status; }
        if (card.classList.contains('is-pinned') !== Boolean(task.pinned)) {
          card.classList.toggle('is-pinned', Boolean(task.pinned));
          const pin = card.querySelector('.card-pin-btn');
          pin.setAttribute('aria-pressed', String(Boolean(task.pinned)));
          pin.title = task.pinned ? I18N.unpinTask : I18N.pinTask;
          pin.setAttribute('aria-label', pin.title);
        }
        const copy = card.querySelector('.card-copy-btn');
        if (copy.dataset.relPath !== task.relPath) {
          copy.dataset.relPath = task.relPath;
          copy.title = `${I18N.copyPath}: ${task.relPath}`;
        }
      }
      const current = zone.querySelectorAll('.kanban-card')[index];
      if (current !== card) { zone.insertBefore(card, current || zone.querySelector('.new-task-form')); }
    });
    filterColumn(column);
    zone.dataset.signature = signature;
    if (focused?.isConnected && document.activeElement !== focused) { focused.focus({ preventScroll: true }); }
    zone.scrollTop = scrollTop;
  }

  let goalSectionDragIdx = null;

  function goalOpsButtonsHtml(sectionIndex, afterItemIndex) {
    return `
      <span class="goal-ops">
        <button type="button"
                class="goal-op-btn"
                draggable="false"
                data-op="item"
                data-section="${sectionIndex}"
                data-after="${afterItemIndex}"
                title="${escapeHtml(I18N.insertGoalTooltip)}" aria-label="${escapeHtml(I18N.insertGoalTooltip)}"><span class="material-icon mi-add" aria-hidden="true"></span></button>
        <button type="button"
                class="goal-op-btn"
                draggable="false"
                data-op="section"
                data-section="${sectionIndex}"
                data-after="${afterItemIndex}"
                title="${escapeHtml(I18N.insertSectionTooltip)}" aria-label="${escapeHtml(I18N.insertSectionTooltip)}"><span class="material-icon mi-post_add" aria-hidden="true"></span></button>
      </span>
    `;
  }

  function renderGoalsView(goals, docsExists) {
    const container = document.getElementById('goals-view');
    if (!container) { return; }

    if (!docsExists) {
      if (container.dataset.goalsSig === 'no-docs') { return; }
      container.dataset.goalsSig = 'no-docs';
      container.innerHTML = `<div class="goals-empty">${escapeHtml(I18N.goalsNoDocs)}</div>`;
      return;
    }

    const sections = Array.isArray(goals?.sections) ? goals.sections : [];
    const sig = JSON.stringify(sections);
    if (container.dataset.goalsSig === sig) { return; }
    container.dataset.goalsSig = sig;

    const sectionsHtml = sections.map((section, sIdx) => {
      const items = Array.isArray(section.items) ? section.items : [];

      const itemsHtml = items.map((item, iIdx) => `
        <div class="goal-line goal-item-row${item.completed ? ' completed' : ''}"
             data-section="${sIdx}"
             data-item="${iIdx}">
          ${goalOpsButtonsHtml(sIdx, iIdx)}
          <input type="checkbox"
                 class="goal-checkbox"
                 data-section="${sIdx}"
                 data-item="${iIdx}"
                 ${item.completed ? 'checked' : ''}>
          <span class="goal-text"
                data-section="${sIdx}"
                data-item="${iIdx}">${escapeHtml(item.text)}</span>
          <button type="button"
                  class="goal-delete-btn"
                  data-section="${sIdx}"
                  data-item="${iIdx}"
                  title="${escapeHtml(I18N.deleteEntryTooltip)}" aria-label="${escapeHtml(I18N.deleteEntryTooltip)}"><span class="material-icon mi-delete" aria-hidden="true"></span></button>
        </div>
      `).join('');

      return `
        <div class="goal-section-group" data-section="${sIdx}">
          <div class="goal-line goal-section-row"
               draggable="true"
               data-section="${sIdx}">
            ${goalOpsButtonsHtml(sIdx, -1)}
            <span class="goal-section-heading"
                  data-section="${sIdx}">${escapeHtml(section.title)}</span>
            <button type="button"
                    class="goal-delete-btn"
                    data-section="${sIdx}"
                    data-item=""
                    title="${escapeHtml(I18N.deleteEntryTooltip)}" aria-label="${escapeHtml(I18N.deleteEntryTooltip)}"><span class="material-icon mi-delete" aria-hidden="true"></span></button>
          </div>
          <div class="goal-section-children">${itemsHtml}</div>
        </div>
      `;
    }).join('');

    container.innerHTML = `<div class="goals-outline">${sectionsHtml}</div>`;

    function openInlineInsert(anchorRow, op, sectionIndex, afterItemIndex) {
      container.querySelectorAll('.goal-inline-editor').forEach(el => el.remove());

      const editor = document.createElement('div');
      editor.className = 'goal-line goal-inline-editor';
      const isSection   = op === 'section';
      const badge       = isSection ? '->' : '+';
      const placeholder = isSection ? I18N.newSectionPlaceholder : I18N.newGoalPlaceholder;

      editor.innerHTML = `
        <span class="goal-ops always-visible">
          <span class="goal-editor-badge">${escapeHtml(badge)}</span>
        </span>
        <input type="text" class="goal-editor-input" placeholder="${escapeHtml(placeholder)}" maxlength="240">
      `;

      anchorRow.insertAdjacentElement('afterend', editor);
      const input = editor.querySelector('.goal-editor-input');
      input.focus();

      let closed = false;
      const close = () => {
        if (closed) { return; }
        closed = true;
        editor.remove();
      };

      const commit = () => {
        if (closed) { return; }
        const val = input.value.trim();
        if (!val) {
          close();
          return;
        }
        closed = true;
        if (isSection) {
          vscode.postMessage({
            command: 'insertGoalSection',
            sectionIndex,
            afterItemIndex,
            title: val,
          });
        } else {
          vscode.postMessage({
            command: 'insertGoalItem',
            sectionIndex,
            afterItemIndex,
            text: val,
          });
        }
        editor.remove();
      };

      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      });

      input.addEventListener('blur', () => {
        if (!input.value.trim()) {
          close();
        } else {
          commit();
        }
      });
    }

    function startInlineTextEdit(spanEl, sectionIndex, itemIndex) {
      if (spanEl.dataset.editing === 'true') { return; }
      spanEl.dataset.editing = 'true';

      const currentText = spanEl.textContent ?? '';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'goal-editor-input goal-edit-inline';
      input.value = currentText;
      input.maxLength = 240;

      spanEl.replaceWith(input);
      input.focus();
      input.select();

      let finished = false;
      const finish = (save) => {
        if (finished) { return; }
        finished = true;
        const nextVal = input.value.trim();
        if (save && nextVal !== currentText) {
          vscode.postMessage({
            command: 'updateGoalEntry',
            sectionIndex,
            itemIndex,
            text: nextVal,
          });
          return;
        }
        delete spanEl.dataset.editing;
        input.replaceWith(spanEl);
      };

      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      });

      input.addEventListener('blur', () => finish(true));
    }

    container.querySelectorAll('.goal-op-btn').forEach(btn => {
      btn.addEventListener('dragstart', e => {
        e.preventDefault();
        e.stopPropagation();
      });

      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        const anchorRow = btn.closest('.goal-line');
        if (!anchorRow) { return; }
        openInlineInsert(
          anchorRow,
          btn.dataset.op || 'item',
          Number(btn.dataset.section),
          Number(btn.dataset.after)
        );
      });
    });

    container.querySelectorAll('.goal-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        vscode.postMessage({
          command: 'toggleGoalItem',
          sectionIndex: Number(cb.dataset.section),
          itemIndex: Number(cb.dataset.item),
        });
      });
    });

    container.querySelectorAll('.goal-text').forEach(el => {
      el.addEventListener('click', () => {
        startInlineTextEdit(el, Number(el.dataset.section), Number(el.dataset.item));
      });
    });

    container.querySelectorAll('.goal-section-heading').forEach(el => {
      el.addEventListener('click', () => {
        startInlineTextEdit(el, Number(el.dataset.section), null);
      });
    });

    container.querySelectorAll('.goal-delete-btn').forEach(btn => {
      btn.addEventListener('dragstart', e => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        const rawItem = btn.dataset.item;
        vscode.postMessage({
          command: 'deleteGoalEntry',
          sectionIndex: Number(btn.dataset.section),
          itemIndex: rawItem === '' || rawItem === undefined ? null : Number(rawItem),
        });
      });
    });

    // Drag & drop entire sections (moves section + all child items together)
    container.querySelectorAll('.goal-section-row').forEach(headerRow => {
      headerRow.addEventListener('dragstart', e => {
        if (e.target.closest('button, input')) {
          e.preventDefault();
          return;
        }
        goalSectionDragIdx = Number(headerRow.dataset.section);
        const group = headerRow.closest('.goal-section-group');
        if (group) { group.classList.add('section-dragging'); }
        e.dataTransfer.effectAllowed = 'move';
      });

      headerRow.addEventListener('dragend', () => {
        goalSectionDragIdx = null;
        container.querySelectorAll('.goal-section-group').forEach(g =>
          g.classList.remove('section-dragging', 'drop-above', 'drop-below')
        );
      });
    });

    container.querySelectorAll('.goal-section-group').forEach(group => {
      group.addEventListener('dragover', e => {
        if (goalSectionDragIdx === null) { return; }
        const targetIdx = Number(group.dataset.section);
        if (targetIdx === goalSectionDragIdx) { return; }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        const rect = group.getBoundingClientRect();
        const mid  = rect.top + rect.height / 2;
        group.classList.remove('drop-above', 'drop-below');
        group.classList.add(e.clientY < mid ? 'drop-above' : 'drop-below');
      });

      group.addEventListener('dragleave', e => {
        if (!group.contains(e.relatedTarget)) {
          group.classList.remove('drop-above', 'drop-below');
        }
      });

      group.addEventListener('drop', e => {
        if (goalSectionDragIdx === null) { return; }
        e.preventDefault();
        group.classList.remove('drop-above', 'drop-below');

        const targetIdx = Number(group.dataset.section);
        const fromIdx   = goalSectionDragIdx;
        goalSectionDragIdx = null;
        if (fromIdx === targetIdx) { return; }

        const rect = group.getBoundingClientRect();
        const insertAfter = e.clientY >= rect.top + rect.height / 2;
        const toIdx = insertAfter
          ? targetIdx + (fromIdx < targetIdx ? 0 : 1)
          : targetIdx - (fromIdx > targetIdx ? 0 : 1);

        if (toIdx !== fromIdx) {
          vscode.postMessage({ command: 'reorderGoalSection', fromIndex: fromIdx, toIndex: toIdx });
        }
      });
    });
  }

  function renderDocListView(type, containerId, docTasks, docsExists) {
    const container = document.getElementById(containerId);
    if (!container) { return; }

    const isOther = type === 'other';
    const tabBtn = isOther ? document.getElementById('tab-btn-other') : null;
    const tasks = Array.isArray(docTasks) ? docTasks : [];

    if (tabBtn) {
      const hasOther = tasks.length > 0 && visibility.other !== false;
      if (tabBtn.hidden !== !hasOther) { tabBtn.hidden = !hasOther; }
      if (!hasOther && tabBtn.classList.contains('active')) {
        setActiveTab('board');
      }
    }

    const sigKey = isOther ? 'otherSig' : 'archSig';
    const sig = JSON.stringify({ docsExists, tasks });
    if (container.dataset[sigKey] === sig) { return; }
    container.dataset[sigKey] = sig;

    const dotClass   = isOther ? 'other-dot' : 'arch-dot';
    const titleClass = isOther ? 'other-title' : 'arch-title';
    const dateClass  = isOther ? 'other-date' : 'arch-date';
    const rowClass   = isOther ? 'other-row' : 'arch-row';
    const emptyClass = isOther ? 'other-empty' : 'arch-empty';
    const emptyMsg   = isOther ? I18N.otherEmpty : I18N.archEmpty;

    const listHtml = tasks.length === 0
      ? `<div class="${emptyClass}">${escapeHtml(emptyMsg || '')}</div>`
      : tasks.map(task => `
          <div class="${rowClass}" data-file-path="${escapeHtml(task.filePath)}">
            <span class="${dotClass}"></span>
            <span class="${titleClass}" data-file-path="${escapeHtml(task.filePath)}">${escapeHtml(task.title)}</span>
            <span class="${dateClass}">${escapeHtml(task.date)}</span>
            ${copyBtnHtml(task.relPath || '')}
            <button type="button"
                    class="doc-delete-btn"
                    data-file-path="${escapeHtml(task.filePath)}"
                    title="${escapeHtml(I18N.deleteDocTooltip || 'Delete')}" aria-label="${escapeHtml(I18N.deleteDocTooltip || 'Delete')}"><span class="material-icon mi-delete" aria-hidden="true"></span></button>
          </div>
        `).join('');

    container.innerHTML = `
      <div class="doc-toolbar doc-toolbar-${type}">
        <button type="button" class="doc-add-trigger" title="${escapeHtml(I18N.addDoc || 'New document')}" aria-label="${escapeHtml(I18N.addDoc || 'New document')}"><span class="material-icon mi-post_add" aria-hidden="true"></span></button>
        <div class="doc-inline-form" hidden>
          <input type="text" class="doc-title-input" placeholder="${escapeHtml(I18N.placeholder)}" maxlength="120">
          <button type="button" class="btn-add doc-submit-btn" disabled title="${escapeHtml(I18N.add)}" aria-label="${escapeHtml(I18N.add)}"><span class="material-icon mi-check" aria-hidden="true"></span></button>
          <button type="button" class="btn-cancel doc-cancel-btn" title="${escapeHtml(I18N.cancel)}" aria-label="${escapeHtml(I18N.cancel)}"><span class="material-icon mi-close" aria-hidden="true"></span></button>
          <div class="new-task-error doc-error-msg" hidden></div>
        </div>
      </div>
      <div class="${type}-list">${listHtml}</div>
    `;

    container.querySelectorAll(`.${titleClass}`).forEach(attachCardTitleListener);
    container.querySelectorAll('.card-copy-btn').forEach(attachCopyBtnListener);
    container.querySelectorAll('.doc-delete-btn').forEach(btn => {
      btn.addEventListener('dragstart', e => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        const fp = btn.dataset.filePath;
        if (fp) {
          vscode.postMessage({ command: 'deleteFile', filePath: fp });
        }
      });
    });

    const triggerBtn = container.querySelector('.doc-add-trigger');
    const inlineForm = container.querySelector('.doc-inline-form');
    const titleInput = container.querySelector('.doc-title-input');
    const submitBtn  = container.querySelector('.doc-submit-btn');
    const cancelBtn  = container.querySelector('.doc-cancel-btn');
    const errorMsg   = container.querySelector('.doc-error-msg');

    const closeForm = () => {
      if (!inlineForm || !triggerBtn || !titleInput || !errorMsg || !submitBtn) { return; }
      inlineForm.hidden = true;
      triggerBtn.hidden = false;
      titleInput.value  = '';
      titleInput.classList.remove('invalid');
      errorMsg.hidden   = true;
      submitBtn.disabled = true;
    };

    const validate = (forceErr) => {
      if (!titleInput || !errorMsg || !submitBtn) { return false; }
      const raw     = titleInput.value;
      const valid   = isValidTaskTitle(raw);
      const showErr = valid ? false : (Boolean(raw.trim()) || Boolean(forceErr));
      titleInput.classList.toggle('invalid', showErr);
      errorMsg.hidden      = !showErr;
      errorMsg.textContent = showErr ? (I18N.invalidTitle || '') : '';
      submitBtn.disabled   = !valid;
      return valid;
    };

    const submit = () => {
      if (!validate(true) || !titleInput) {
        titleInput?.focus();
        return;
      }
      vscode.postMessage({ command: 'createTask', title: titleInput.value.trim(), status: type });
      closeForm();
    };

    triggerBtn?.addEventListener('click', () => {
      if (!inlineForm || !triggerBtn) { return; }
      triggerBtn.hidden = true;
      inlineForm.hidden = false;
      titleInput?.focus();
    });

    titleInput?.addEventListener('input', () => validate(false));
    submitBtn?.addEventListener('click', submit);
    cancelBtn?.addEventListener('click', closeForm);
    titleInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { submit(); }
      if (e.key === 'Escape') { closeForm(); }
    });
  }

  function renderArchitectureView(archTasks, docsExists) {
    renderDocListView('architecture', 'architecture-view', archTasks, docsExists);
  }

  function renderOtherView(otherTasks, docsExists) {
    renderDocListView('other', 'other-view', otherTasks, docsExists);
  }

  function renderTasksState(state) {
    if (!state) { return; }

    if (JSON.stringify(state) === JSON.stringify(lastRenderedState)) { return; }
    const previous = lastRenderedState;
    lastRenderedState = state;
    applyVisibility(state.visibility ?? {});
    document.querySelectorAll('.column-sort-select').forEach(select => {
      const sort = state.columnSorts[select.dataset.status];
      if (select.value !== sort) { select.value = sort; }
      const title = select.selectedOptions[0]?.textContent ?? '';
      if (select.title !== title) { select.title = title; }
    });
    if (state.docsExists !== previous.docsExists) { updateHeaderControls(Boolean(state.docsExists)); }
    if (state.uiScale !== previous.uiScale) { applyUiScale(state.uiScale ?? 100); }
    if (state.docsExists !== previous.docsExists || state.hasWorkspace !== previous.hasWorkspace) {
      const projectToggle = document.getElementById('project-enabled-toggle');
      if (projectToggle) {
        projectToggle.checked = Boolean(state.docsExists);
        projectToggle.disabled = !state.hasWorkspace;
      }
      const projectState = document.getElementById('project-state');
      if (projectState) {
        projectState.textContent = state.docsExists ? I18N.settingsEnabled : I18N.settingsDisabled;
        projectState.classList.toggle('is-on', Boolean(state.docsExists));
      }
    }
    if (state.showCopyPathIcon !== previous.showCopyPathIcon) {
      const showCopy = state.showCopyPathIcon !== false;
      applyCopyVisibility(showCopy);
      const copyToggle = document.getElementById('toggle-copy-icon-checkbox');
      if (copyToggle) { copyToggle.checked = showCopy; }
    }
    const board = document.querySelector('.kanban-board');
    if (board && Array.isArray(state.order)) {
      state.order.forEach((status, index) => {
        const column = board.querySelector(`.kanban-column[data-status="${status}"]`);
        if (column && board.children[index] !== column) { board.insertBefore(column, board.children[index] || null); }
      });
    }

    Object.entries(state.tasks ?? {}).forEach(([status, tasks]) => {
      updateColumn(status, tasks ?? []);
    });

    renderGoalsView(state.goals, Boolean(state.docsExists));
    renderArchitectureView(state.tasks?.architecture ?? [], Boolean(state.docsExists));
    renderOtherView(state.tasks?.other ?? [], Boolean(state.docsExists));
  }

  // ── Card drag ─────────────────────────────────────────────────

  document.querySelectorAll('.column-cards').forEach(zone => {
    zone.dataset.signature = currentZoneSignature(zone);
  });

  document.querySelectorAll('.kanban-card').forEach(attachCardListeners);

  // ── Card drop zones ───────────────────────────────────────────

  document.querySelectorAll('.column-cards').forEach(zone => {
    if (zone.dataset.dropOk !== 'true') { return; }

    zone.addEventListener('dragover', e => {
      if (dragMode !== 'card') { return; }
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      zone.classList.add('drag-over');
    });

    zone.addEventListener('dragleave', e => {
      if (!zone.contains(e.relatedTarget)) { zone.classList.remove('drag-over'); }
    });

    zone.addEventListener('drop', e => {
      if (dragMode !== 'card') { return; }
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('drag-over');
      const newStatus = zone.dataset.status;
      if (!cardDragPath || newStatus === cardDragStatus) { return; }
      vscode.postMessage({ command: 'moveTask', filePath: cardDragPath, newStatus });
    });
  });

  // ── Column header drag ────────────────────────────────────────

  document.querySelectorAll('.column-header').forEach(header => {
    header.addEventListener('dragstart', e => {
      dragMode         = 'column';
      columnDragStatus = header.dataset.status;
      header.closest('.kanban-column').classList.add('column-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    header.addEventListener('dragend', () => {
      document.querySelectorAll('.kanban-column').forEach(c =>
        c.classList.remove('column-dragging', 'col-drop-before', 'col-drop-after')
      );
      columnDragStatus = null;
      dragMode = null;
    });
  });

  // ── Column drop zones ─────────────────────────────────────────

  document.querySelectorAll('.kanban-column').forEach(col => {
    col.addEventListener('dragover', e => {
      if (dragMode !== 'column') { return; }
      if (col.dataset.status === columnDragStatus) { return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      // Show indicator on left/right half
      const rect = col.getBoundingClientRect();
      const mid  = rect.left + rect.width / 2;
      col.classList.remove('col-drop-before', 'col-drop-after');
      col.classList.add(e.clientX < mid ? 'col-drop-before' : 'col-drop-after');
    });

    col.addEventListener('dragleave', e => {
      if (!col.contains(e.relatedTarget)) {
        col.classList.remove('col-drop-before', 'col-drop-after');
      }
    });

    col.addEventListener('drop', e => {
      if (dragMode !== 'column') { return; }
      e.preventDefault();
      col.classList.remove('col-drop-before', 'col-drop-after');

      const targetStatus = col.dataset.status;
      if (!columnDragStatus || targetStatus === columnDragStatus) { return; }

      const allCols = [...document.querySelectorAll('.kanban-column')];
      const order   = allCols.map(c => c.dataset.status);
      const from    = order.indexOf(columnDragStatus);
      const to      = order.indexOf(targetStatus);

      const rect = col.getBoundingClientRect();
      const insertAfter = e.clientX >= rect.left + rect.width / 2;
      const insertIdx   = insertAfter ? to + (from < to ? 0 : 1) : to - (from > to ? 0 : 1);

      order.splice(from, 1);
      order.splice(Math.max(0, Math.min(insertIdx, order.length)), 0, columnDragStatus);

      vscode.postMessage({ command: 'reorderColumns', order });
    });
  });

  // ── Open file on card title click ─────────────────────────────

  document.querySelectorAll('.card-title').forEach(attachCardTitleListener);

  // ── "+" new task (hover-revealed bottom button) ───────────────

  const SAFE_TITLE_REGEX = /^[a-zA-Z0-9 _-]+$/;
  const HAS_ALNUM_REGEX  = /[a-zA-Z0-9]/;
  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  function isValidTaskTitle(value) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) { return false; }
    if (!SAFE_TITLE_REGEX.test(trimmed) || !HAS_ALNUM_REGEX.test(trimmed)) {
      return false;
    }
    const slug = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 60);
    return Boolean(slug && !WINDOWS_RESERVED.test(slug));
  }

  document.querySelectorAll('.add-task-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const status = btn.dataset.status;
      const column = btn.closest('.kanban-column');
      if (!column || column.querySelector('.new-task-form')) { return; }

      btn.classList.add('hidden');

      const form  = document.createElement('div');
      form.className = 'new-task-form';
      form.innerHTML = `
        <input class="new-task-input" type="text" placeholder="${escapeHtml(I18N.placeholder)}" maxlength="120">
        <div class="new-task-error" hidden></div>
        <div class="new-task-actions">
          <button class="btn-add" disabled title="${escapeHtml(I18N.add)}" aria-label="${escapeHtml(I18N.add)}"><span class="material-icon mi-check" aria-hidden="true"></span></button>
          <button class="btn-cancel" title="${escapeHtml(I18N.cancel)}" aria-label="${escapeHtml(I18N.cancel)}"><span class="material-icon mi-close" aria-hidden="true"></span></button>
        </div>
      `;

      column.querySelector('.column-cards').appendChild(form);
      const input    = form.querySelector('.new-task-input');
      const errorEl  = form.querySelector('.new-task-error');
      const addBtn   = form.querySelector('.btn-add');
      input.focus();

      const validate = (forceShowError) => {
        const raw     = input.value;
        const trimmed = raw.trim();
        const valid   = isValidTaskTitle(raw);
        const showErr = valid ? false : (Boolean(trimmed) || Boolean(forceShowError));

        input.classList.toggle('invalid', showErr);
        errorEl.hidden      = !showErr;
        errorEl.textContent = showErr ? (I18N.invalidTitle || '') : '';
        addBtn.disabled     = !valid;
        return valid;
      };

      const cleanup = () => { form.remove(); btn.classList.remove('hidden'); };
      const submit  = () => {
        if (!validate(true)) {
          input.focus();
          return;
        }
        const title = input.value.trim();
        vscode.postMessage({ command: 'createTask', title, status });
        cleanup();
      };

      input.addEventListener('input', () => validate(false));
      addBtn.addEventListener('click', submit);
      form.querySelector('.btn-cancel').addEventListener('click', cleanup);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { submit(); }
        if (e.key === 'Escape') { cleanup(); }
      });
    });
  });

  // ── Tabs & Header buttons ─────────────────────────────────────

  function applyVisibility(next) {
    visibility = next;
    for (const [key, className] of [['status', 'hide-status-indicators'], ['count', 'hide-document-counts']]) {
      const hidden = visibility[key] === false;
      if (document.body.classList.contains(className) !== hidden) { document.body.classList.toggle(className, hidden); }
    }
    const targets = {goals: '[data-tab="goals"]', architecture: '[data-tab="architecture"]',
      other: '[data-tab="other"]', agents: '#agent-btn', save: '#save-changes-btn', refresh: '#refresh-btn', status: null, count: null};
    Object.entries(targets).forEach(([key, selector]) => {
      const enabled = visibility[key] !== false;
      const target = selector ? document.querySelector(selector) : null;
      const hidden = !enabled || (key === 'other' && !(lastRenderedState.tasks?.other?.length > 0));
      if (target && target.hidden !== hidden) { target.hidden = hidden; }
      if (hidden && target?.classList.contains('active')) { setActiveTab('board'); }
      const input = document.querySelector(`[data-visibility="${key}"]`);
      if (input) { input.checked = enabled; }
      const label = document.querySelector(`[data-visibility-state="${key}"]`);
      if (label) {
        const text = enabled ? I18N.settingsEnabled : I18N.settingsDisabled;
        if (label.textContent !== text) { label.textContent = text; }
        if (label.classList.contains('is-on') !== enabled) { label.classList.toggle('is-on', enabled); }
      }
    });
  }

  document.querySelectorAll('[data-visibility]').forEach(input => {
    input.addEventListener('change', () => {
      vscode.postMessage({ command: 'setVisibility', item: input.dataset.visibility, enabled: input.checked });
    });
  });

  function setActiveTab(tabName) {
    if (document.querySelector(`.tab-btn[data-tab="${tabName}"]`)?.hidden) { tabName = 'board'; }
    const boardView        = document.getElementById('board-view');
    const goalsView        = document.getElementById('goals-view');
    const architectureView = document.getElementById('architecture-view');
    const otherView        = document.getElementById('other-view');
    const settingsView     = document.getElementById('settings-view');
    document.querySelectorAll('.tab-btn').forEach(btn => {
      const isActive = btn.dataset.tab === tabName;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    if (boardView)        { boardView.hidden        = tabName !== 'board'; }
    if (goalsView)        { goalsView.hidden        = tabName !== 'goals'; }
    if (architectureView) { architectureView.hidden = tabName !== 'architecture'; }
    if (otherView)        { otherView.hidden        = tabName !== 'other'; }
    if (settingsView)     { settingsView.hidden     = tabName !== 'settings'; }
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab || 'board'));
  });

  if (typeof INITIAL_GOALS_STATE !== 'undefined') {
    renderGoalsView(INITIAL_GOALS_STATE.goals, Boolean(INITIAL_GOALS_STATE.docsExists));
    renderArchitectureView(INITIAL_GOALS_STATE.architectureTasks ?? [], Boolean(INITIAL_GOALS_STATE.docsExists));
    renderOtherView(INITIAL_GOALS_STATE.otherTasks ?? [], Boolean(INITIAL_GOALS_STATE.docsExists));
  }

  document.querySelectorAll('.column-sort-select').forEach(select => {
    select.addEventListener('change', () => {
      vscode.postMessage({ command: 'setColumnSort', status: select.dataset.status, sort: select.value });
    });
    select.closest('.column-sort-control').addEventListener('dragstart', e => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  document.getElementById('agent-btn')?.addEventListener('click', () =>
    vscode.postMessage({ command: 'openAgents' })
  );

  function applyUiScale(scale) {
    document.body.style.zoom = String(scale / 100);
    document.body.style.height = `${10000 / scale}%`;
    const select = document.getElementById('settings-scale-select');
    if (select) { select.value = String(scale); }
  }

  document.getElementById('settings-scale-select')?.addEventListener('change', e => {
    const scale = Number(e.target.value);
    applyUiScale(scale);
    vscode.postMessage({ command: 'setUiScale', scale });
  });

  document.getElementById('project-enabled-toggle')?.addEventListener('change', e => {
    e.target.disabled = true;
    vscode.postMessage({ command: 'toggleProject', enabled: e.target.checked });
  });

  document.getElementById('settings-language-select')?.addEventListener('change', e => {
    const select = e.target;
    if (select && select.value) {
      vscode.postMessage({ command: 'setLanguage', language: select.value });
    }
  });

  document.getElementById('author-link')?.addEventListener('click', e => {
    e.preventDefault();
    vscode.postMessage({ command: 'openExternal', url: 'https://github.com/veizeczek' });
  });

  function applyCopyVisibility(enabled) {
    document.body.classList.toggle('hide-copy-icon', !enabled);
    const label = document.getElementById('copy-visibility-state');
    if (label) {
      label.textContent = enabled ? I18N.settingsEnabled : I18N.settingsDisabled;
      label.classList.toggle('is-on', enabled);
    }
  }

  const copyToggleEl = document.getElementById('toggle-copy-icon-checkbox');
  copyToggleEl?.addEventListener('change', () => {
    const enabled = Boolean(copyToggleEl.checked);
    applyCopyVisibility(enabled);
    vscode.postMessage({ command: 'toggleCopyPathIcon', enabled });
  });

  const saveChangesBtn = document.getElementById('save-changes-btn');
  saveChangesBtn?.addEventListener('click', () => {
    if (saveChangesBtn.disabled) { return; }
    saveChangesInFlight = true;
    saveChangesBtn.disabled = true;
    vscode.postMessage({ command: 'saveDocsChanges' });
  });

  const refreshBtn = document.getElementById('refresh-btn');
  const refreshStatus = document.getElementById('refresh-status');
  let refreshResetTimer;

  function setRefreshFeedback(state) {
    if (!refreshBtn) { return; }
    const label = state === 'loading' ? I18N.refreshing
      : state === 'done' ? I18N.refreshed : state === 'error' ? I18N.refreshFailed : I18N.refresh;
    refreshBtn.disabled = state === 'loading';
    refreshBtn.setAttribute('aria-busy', String(state === 'loading'));
    refreshBtn.title = label;
    refreshBtn.setAttribute('aria-label', label);
    refreshBtn.classList.toggle('is-refreshing', state === 'loading');
    refreshBtn.classList.toggle('is-refreshed', state === 'done');
    refreshBtn.querySelector('.material-icon').className = 'material-icon ' + (state === 'done' ? 'mi-check' : 'mi-refresh');
    if (refreshStatus) { refreshStatus.textContent = state === 'idle' ? '' : label; }
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.command === 'visibilitySettings') {
      applyVisibility(message.visibility ?? {});
      return;
    }
    if (message?.command === 'renderTasks') {
      renderTasksState(message.state);
      return;
    }

    if (message?.command === 'toggleProjectDone') {
      const toggle = document.getElementById('project-enabled-toggle');
      if (toggle) {
        toggle.checked = Boolean(lastRenderedState.docsExists);
        toggle.disabled = !lastRenderedState.hasWorkspace;
      }
      return;
    }

    if (message?.command === 'refreshDone') {
      clearTimeout(refreshResetTimer);
      setRefreshFeedback(message.success ? 'done' : 'error');
      refreshResetTimer = setTimeout(() => setRefreshFeedback('idle'), 1600);
      return;
    }

    if (message?.command === 'saveDocsChangesDone' && saveChangesBtn) {
      saveChangesInFlight = false;
      saveChangesBtn.disabled = !lastRenderedState.docsExists;
    }
  });

  refreshBtn?.addEventListener('click', () => {
    if (refreshBtn.disabled) { return; }
    clearTimeout(refreshResetTimer);
    setRefreshFeedback('loading');
    vscode.postMessage({ command: 'refresh' });
  });
}());
