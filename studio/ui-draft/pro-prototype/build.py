"""Build studio/ui-draft/pro-prototype.html from the live workbench DOM snapshot,
the workbench's own stylesheets and the prototype layer (prototype.css, prototype.js).
Run from anywhere: python3 studio/ui-draft/pro-prototype/build.py"""
import hashlib, json, re, pathlib, subprocess
HERE = pathlib.Path(__file__).resolve().parent
UI = HERE.parent
d = json.loads((HERE / 'live-dom.json').read_text())

def versioned(name):
    digest = hashlib.sha256((HERE / name).read_bytes()).hexdigest()[:12]
    return f'pro-prototype/{name}?v={digest}'


styles = ['draft.css', 'inspector.css', 'guizang-trial.css', 'shell-v5.css', versioned('prototype.css')]
links = ''.join(f'<link rel="stylesheet" href="{name}">' for name in styles)
engine_revision = hashlib.sha256((UI / 'engine.html').read_bytes()).hexdigest()[:12]

app = d['app']
app = re.sub(r'<button class="layer-row" data-layer="waterfront"[^>]*>.*?</button>', '', app, count=1, flags=re.S)
app = re.sub(r'(<div id="artboard") style="[^"]*"', r'\1', app, count=1)
app = app.replace(' \u00b7 ', ', ')  # hidden artboard label; copy rule 6
# The motion runtime owns the selection indicators and initializes their geometry.
app = re.sub(r'<span class="(?:scene|segment)-indicator"[^>]*></span>', '', app)
# Runtime geometry from the snapshot; prototype.js recomputes it on load.
app = re.sub(r' style="width: [\d.]+px;(?: height: [\d.]+px; transform: translate3d\([^)]*\);)?"', '', app)
section_end = '</section>'
scene_end = app.index(section_end, app.index('id="scene-settings"')) + len(section_end)
layers_id = app.index('id="layers"', scene_end)
layers_start = app.rindex('<section', scene_end, layers_id)
layers_end = app.index(section_end, layers_id) + len(section_end)
app = (app[:scene_end] + app[layers_start:layers_end] + app[scene_end:layers_start]
       + '<section id="interaction-settings"></section>' + app[layers_end:])

html = f'''<!DOCTYPE html>
<html {d['htmlAttrs']}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="scene-engine-revision" content="{engine_revision}">
<title>DriveScene Studio</title>
<link rel="icon" href="../../favicon-32.png" sizes="32x32">
<script>
(() => {{
  const query = new URLSearchParams(location.search);
  const root = document.documentElement;
  const parked = query.get('view') === 'parked' && !query.get('interaction') &&
    ['parking', 'outdoor'].includes(query.get('scene'));
  const state = parked ? history.state?.parkedPreview : null;
  let theme = state?.theme;
  try {{ theme = localStorage.getItem('sr-ui-draft-theme') ?? theme; }} catch {{}}
  root.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  if (!parked) return;
  root.dataset.parkedEntry = '';
  if (state?.theme === root.dataset.theme && state.poster?.startsWith('data:image/jpeg;base64,')) {{
    root.style.setProperty('--parked-entry-frame', 'url("' + state.poster + '")');
  }}
}})();
</script>
{links}
</head>
<body data-ready="true">
{app}
{d['extra']}
<script type="module" src="{versioned('prototype.js')}"></script>
</body>
</html>
'''
(UI / 'pro-prototype.html').write_text(html)
subprocess.run(['node', str(HERE / 'build-shell.mjs')], check=True)
print('wrote', UI / 'pro-prototype.html', len(html))
