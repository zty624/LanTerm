// Worker timers are not subject to the heavy throttling of hidden tabs, so agent
// alerts still arrive while LanTerm runs in the background.
setInterval(() => postMessage('tick'), 3000);
