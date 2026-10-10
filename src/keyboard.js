/** Select a focused field's contents using the browser host's shortcut. */
export async function selectAll(keyboard, platform = process.platform) {
  const modifier = platform === 'darwin' ? 'Meta' : 'Control';
  await keyboard.down(modifier);
  try { await keyboard.press('KeyA'); }
  finally { await keyboard.up(modifier); }
}
