// Admin-only presentation. All reads and writes use the existing authenticated call().
export function createWallOrderAdmin({ call, document = globalThis.document, confirmRemove = message => globalThis.confirm(message) }) {
  const root = document.getElementById('wallAdminList');
  const addForm = document.getElementById('wallForm');
  const status = document.getElementById('wallAdminStatus');
  const saveOrder = document.getElementById('wallSaveOrder');
  const cancelOrder = document.getElementById('wallCancelOrder');
  const orderState = document.getElementById('wallOrderState');
  const labels = { 'rich-gift': 'Rich Gift', gold: 'Gold', platinum: 'Platinum', diamond: 'Diamond' };
  let entries = [];
  let published = [];
  let busy = false;
  let conflict = false;
  let editingId = null;
  let loading = null;
  let rowControls = new Map();
  const ids = rows => rows.map(entry => entry.id);
  const dirty = () => entries.length !== published.length || entries.some((entry, index) => entry.id !== published[index]?.id);
  const tell = message => { status.textContent = message; };
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, secondary = false) => {
    const node = element('button', text, secondary ? 'secondary' : '');
    node.type = 'button';
    return node;
  };
  function acceptEntries(result) {
    if (!Array.isArray(result?.entries) || result.entries.some(entry => !entry || typeof entry.id !== 'string') || new Set(ids(result.entries)).size !== result.entries.length) {
      throw new Error('No se ha podido leer el orden del Wall. Vuelve a cargar el panel.');
    }
    entries = result.entries.map(entry => ({ ...entry }));
    published = entries.map(entry => ({ ...entry }));
    conflict = false;
    editingId = null;
  }
  function updateControls() {
    const pending = dirty();
    const blockEdits = busy || pending || conflict;
    addForm.querySelectorAll('input, select, textarea, button').forEach(node => { node.disabled = blockEdits || editingId !== null; });
    saveOrder.disabled = busy || !pending || conflict || editingId !== null;
    cancelOrder.disabled = busy || (!pending && !conflict);
    root.setAttribute('aria-busy', String(busy));
    orderState.textContent = busy ? 'Guardando o cargando…' : conflict ? 'La lista ha cambiado en otra sesión.' : pending ? 'Cambios sin guardar.' : 'Orden publicado.';
    for (const [id, controls] of rowControls) {
      const index = entries.findIndex(entry => entry.id === id);
      controls.up.disabled = busy || conflict || editingId !== null || index === 0;
      controls.down.disabled = busy || conflict || editingId !== null || index === entries.length - 1;
      controls.edit.disabled = blockEdits || editingId !== null;
      controls.remove.disabled = blockEdits || editingId !== null;
      controls.form.querySelectorAll('input, select, button').forEach(node => { node.disabled = blockEdits; });
    }
  }
  function canEdit() {
    if (busy || dirty() || conflict) {
      tell('Guarda o cancela el cambio de orden antes de añadir, editar o eliminar una entrada.');
      return false;
    }
    return true;
  }
  function move(id, direction) {
    if (busy || conflict || editingId !== null) return;
    const from = entries.findIndex(entry => entry.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= entries.length) return;
    [entries[from], entries[to]] = [entries[to], entries[from]];
    render();
    const controls = rowControls.get(id);
    const preferred = direction < 0 ? controls.up : controls.down;
    const alternate = direction < 0 ? controls.down : controls.up;
    (preferred.disabled ? alternate : preferred).focus();
    tell(`${entries[to].display_name}: posición ${to + 1}. ${dirty() ? 'Guarda el orden para publicarlo.' : 'Se mantiene el orden publicado.'}`);
  }
  async function mutate(action, data, successMessage, afterWrite = () => {}) {
    if (!canEdit()) return;
    busy = true;
    updateControls();
    let written = false;
    tell('Guardando…');
    try {
      await call(action, data);
      written = true;
      afterWrite();
      acceptEntries(await call('wall_list'));
      render();
      tell(successMessage);
    } catch (error) {
      tell(written ? 'El cambio se ha guardado, pero no se ha podido recargar la lista. Vuelve a cargar el panel.' : error.message || 'No se ha podido guardar el cambio.');
    } finally {
      busy = false;
      updateControls();
    }
  }
  function editForm(entry) {
    const form = element('form');
    form.hidden = true;
    form.className = 'wall-entry-edit';
    const nameLabel = element('label', 'NAME OR ALIAS');
    const name = element('input');
    name.value = entry.display_name;
    name.required = true;
    name.maxLength = 60;
    nameLabel.append(name);
    const editionLabel = element('label', 'EDITION');
    const edition = element('select');
    for (const [value, label] of Object.entries(labels)) {
      const option = element('option', label);
      option.value = value;
      edition.append(option);
    }
    edition.value = entry.edition;
    editionLabel.append(edition);
    const countryLabel = element('label', 'COUNTRY CODE (OPTIONAL)');
    const country = element('input');
    country.value = entry.country_code || '';
    country.maxLength = 2;
    country.pattern = '[A-Za-z]{2}';
    country.placeholder = 'e.g. ES for Spain';
    countryLabel.append(country);
    const save = button('SAVE CHANGES');
    save.type = 'submit';
    const cancel = button('CANCEL', true);
    const actions = element('div', undefined, 'wall-entry-actions');
    actions.append(save, cancel);
    form.append(nameLabel, editionLabel, countryLabel, actions);
    cancel.addEventListener('click', () => {
      form.hidden = true;
      editingId = null;
      updateControls();
      rowControls.get(entry.id).edit.focus();
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!canEdit()) return;
      mutate('wall_update', { id: entry.id, display_name: name.value, edition: edition.value, country_code: country.value }, 'Entrada actualizada.');
    });
    return { form, name };
  }
  function render() {
    root.replaceChildren();
    rowControls = new Map();
    entries.forEach((entry, index) => {
      const row = element('div', undefined, 'wall-admin-row');
      row.setAttribute('role', 'listitem');
      row.dataset.wallId = entry.id;
      const heading = element('div', undefined, 'wall-entry-heading');
      const position = element('span', String(index + 1), 'wall-entry-position');
      position.setAttribute('aria-label', `Posición ${index + 1}`);
      const identity = element('div', undefined, 'wall-entry-identity');
      identity.append(element('strong', entry.display_name), element('span', (labels[entry.edition] || entry.edition) + (entry.country_code ? ` · ${entry.country_code}` : ''), 'muted'));
      heading.append(position, identity);
      if (index < 3) heading.append(element('span', 'Visible en portada', 'wall-entry-featured'));
      const actions = element('div', undefined, 'wall-entry-actions');
      const up = button('↑ Subir', true);
      const down = button('↓ Bajar', true);
      const edit = button('EDIT');
      const remove = button('REMOVE');
      up.setAttribute('aria-label', `Subir a ${entry.display_name}`);
      down.setAttribute('aria-label', `Bajar a ${entry.display_name}`);
      up.addEventListener('click', () => move(entry.id, -1));
      down.addEventListener('click', () => move(entry.id, 1));
      const editor = editForm(entry);
      edit.addEventListener('click', () => {
        if (!canEdit() || editingId !== null) return;
        editingId = entry.id;
        editor.form.hidden = false;
        updateControls();
        editor.name.focus();
      });
      remove.addEventListener('click', () => {
        if (!canEdit() || editingId !== null || !confirmRemove('Remove this person from the public wall?')) return;
        mutate('wall_remove', { id: entry.id }, 'Entrada eliminada del Wall.');
      });
      actions.append(up, down, edit, remove);
      row.append(heading, actions, editor.form);
      rowControls.set(entry.id, { row, up, down, edit, remove, form: editor.form });
      root.append(row);
    });
    if (!entries.length) root.append(element('p', 'No hay entradas todavía.', 'muted'));
    updateControls();
  }
  async function load({ discardDraft = false } = {}) {
    // Other dashboard operations refresh the overview. Preserve any unsaved Wall work.
    if (loading) return loading;
    if (busy || (!discardDraft && (dirty() || editingId !== null || conflict))) return;
    busy = true;
    updateControls();
    loading = (async () => {
      try {
        acceptEntries(await call('wall_list'));
        render();
      } finally {
        busy = false;
        loading = null;
        updateControls();
      }
    })();
    return loading;
  }
  saveOrder.addEventListener('click', async () => {
    if (busy || !dirty() || conflict || editingId !== null) return;
    busy = true;
    updateControls();
    tell('Guardando el nuevo orden…');
    try {
      acceptEntries(await call('wall_reorder', { order_ids: ids(entries), expected_ids: ids(published) }));
      render();
      tell('Orden guardado. Las tres primeras posiciones se muestran en portada.');
    } catch (error) {
      if (error.status === 409) {
        conflict = true;
        tell('La lista ha cambiado en otra sesión. Tu borrador sigue visible. Pulsa Cancelar cambios para cargar el orden actual.');
      } else tell(error.message || 'No se ha podido guardar el orden. Tus cambios siguen pendientes.');
    } finally {
      busy = false;
      updateControls();
    }
  });
  cancelOrder.addEventListener('click', async () => {
    if (busy) return;
    if (conflict) {
      try {
        await load({ discardDraft: true });
        tell('Se ha cargado el orden publicado.');
      } catch (error) { tell(error.message || 'No se ha podido cargar el orden actual. Inténtalo de nuevo.'); }
    } else {
      entries = published.map(entry => ({ ...entry }));
      render();
      tell('Cambios descartados. Se mantiene el orden publicado.');
    }
  });
  addForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!canEdit() || editingId !== null) return;
    mutate('wall_add', {
      display_name: document.getElementById('wallName').value,
      edition: document.getElementById('wallEdition').value,
      country_code: document.getElementById('wallCountry').value
    }, 'Entrada añadida al Wall.', () => {
      document.getElementById('wallName').value = '';
      document.getElementById('wallCountry').value = '';
    });
  });
  return { load };
}
