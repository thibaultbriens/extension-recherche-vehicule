(() => {
  const escape = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function markdown(raw) {
    const inline = s => escape(s).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>');
    let code = false;
    return raw.split(/\r?\n/).map(line => {
      if (/^```/.test(line)) { code = !code; return code ? '<pre><code>' : '</code></pre>'; }
      if (code) return escape(line)+'\n';
      const h = line.match(/^(#{1,6})\s+(.+)/);
      if(h) return `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
      if (/^\s*[-*_]{3,}\s*$/.test(line)) return '<hr>';
      if (/^> ?/.test(line)) return `<blockquote>${inline(line.replace(/^> ?/,''))}</blockquote>`;
      if (/^\s*[-*+] /.test(line)) return `<div>${inline(line.replace(/^\s*[-*+] /,'• '))}</div>`;
      return line.trim() ? `<p>${inline(line)}</p>` : '';
    }).join('')+(code ? '</code></pre>' : '');
  }
  function message(raw) {
    const marked = raw.match(/MESSAGE_VENDEUR_DEBUT\s*\n([\s\S]*?)\n\s*MESSAGE_VENDEUR_FIN/);
    if (marked) return marked[1].trim();
    const section = raw.match(/^(?:#{1,6}\s*)?(?:\*\*)?Message (?:à envoyer|au vendeur|au propriétaire)[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|$)/im);
    return section ? section[1].trim().replace(/^```[^\n]*\n|\n```$/g,'').replace(/^> ?/gm,'') : '';
  }
  globalThis.VanCheckFormatting = { markdown, message };
  if (typeof module !== 'undefined') module.exports = { markdown, message };
})();
