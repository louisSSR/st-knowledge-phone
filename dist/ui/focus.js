export function captureFocus(shadow) {
    const active = shadow.activeElement;
    const key = active?.dataset.focusKey;
    if (!key)
        return null;
    return {
        key,
        start: active instanceof HTMLInputElement ? active.selectionStart : null,
        end: active instanceof HTMLInputElement ? active.selectionEnd : null,
    };
}
export function restoreFocus(shadow, snapshot) {
    if (!snapshot)
        return false;
    const target = [...shadow.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === snapshot.key);
    if (!target)
        return false;
    target.focus({ preventScroll: true });
    if (target instanceof HTMLInputElement && snapshot.start !== null && snapshot.end !== null) {
        try {
            target.setSelectionRange(snapshot.start, snapshot.end);
        }
        catch { /* Date inputs do not support selection. */ }
    }
    return true;
}
export function captureDraft(content) {
    return [...content.querySelectorAll('input[data-focus-key],select[data-focus-key]')].map(input => ({
        key: input.dataset.focusKey, value: input.value,
        checked: input instanceof HTMLInputElement && input.checked,
    }));
}
export function restoreDraft(content, fields, queryChanged) {
    const controls = [...content.querySelectorAll('input[data-focus-key],select[data-focus-key]')];
    for (const field of fields) {
        if (field.key === 'query' && queryChanged)
            continue;
        const input = controls.find(control => control.dataset.focusKey === field.key);
        if (!input)
            continue;
        input.value = field.value;
        if (input instanceof HTMLInputElement)
            input.checked = field.checked;
    }
    const mode = controls.find(input => input.name === 'mode');
    if (mode)
        mode.dispatchEvent(new Event('change'));
}
