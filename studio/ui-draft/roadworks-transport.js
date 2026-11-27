export function createRoadworksTransport(bridge) {
 const timeline = document.createElement('input');
 timeline.type = 'range';
 timeline.id = 'roadworks-timeline';
 timeline.min = '0';
 timeline.step = '.1';
 timeline.style.accentColor = 'var(--ds-color-accent)';
 timeline.setAttribute('aria-label','Scene time');
 timeline.addEventListener('input', () => bridge().seekRoadworks(timeline.valueAsNumber));

 return {
  render(button, status, disabled) {
   const demo = status?.roadworks;
   if (!demo) {
    timeline.remove();
    return false;
   }
   if (timeline.parentElement !== button.parentElement) button.after(timeline);
   timeline.max = String(demo.duration);
   timeline.value = String(demo.time);
   timeline.disabled = disabled;
   timeline.setAttribute('aria-valuetext', `${demo.time.toFixed(1)} s / ${demo.duration} s`);
   const label = status.playing ? 'Pause' : demo.time >= demo.duration ? 'Replay' : 'Play';
   button.disabled = disabled;
   button.hidden = false;
   if (button.textContent !== label) button.textContent = label;
   button.setAttribute('aria-label',label);
   button.dataset.tip = label;
   button.dataset.finished = 'false';
   button.removeAttribute('role');
   button.removeAttribute('aria-checked');
   return true;
  },
 };
}
