export const getAutofillScript = (user: string, pass: string) => `
(function(){
    const u='${user}'; 
    const p='${pass}';
    
    // Função React-Safe para setar valor
    function setNativeValue(element, value) {
        const valueSetter = Object.getOwnPropertyDescriptor(element, 'value').set;
        const prototype = Object.getPrototypeOf(element);
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
        if (valueSetter && valueSetter !== prototypeValueSetter) {
            prototypeValueSetter.call(element, value);
        } else {
            valueSetter.call(element, value);
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function fill() {
        // Google e Genéricos
        let iU = document.querySelector('input[type="email"], input[name="identifier"]');
        let iP = document.querySelector('input[type="password"], input[name="password"]');
        
        if (!iU) iU = document.querySelector('input[type="text"], input[name*="user"], input[name*="login"]');

        if(iU && iU.value !== u && !iU.readOnly && iU.offsetParent) { 
            iU.focus(); setNativeValue(iU, u); iU.blur(); 
        }
        if(iP && iP.value !== p && !iP.readOnly && iP.offsetParent) { 
            iP.focus(); setNativeValue(iP, p); iP.blur(); 
        }
    }
    setInterval(fill, 1000);
})();
`;

export const getInjectLSScript = (storageObj: any) => {
    return Object.entries(storageObj)
      .map(([k, v]) => `localStorage.setItem('${k}','${String(v).replace(/'/g, "\\'")}')`)
      .join(';');
};