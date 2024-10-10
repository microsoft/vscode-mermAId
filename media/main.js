(function () {
    const vscode = acquireVsCodeApi();

    zoomLevel = 1;

    const interaval = setInterval(() => {
        if (makeDraggable()) {
            clearInterval(interaval);

            document.getElementById("zoom-in").addEventListener("click", () => {
                zoomDiagram();
            });
            document.getElementById("zoom-out").addEventListener("click", () => {
                zoomDiagram(-0.1);
            });
        }
    }, 500);

    function zoomDiagram(increment = 0.1) {
        zoomLevel += increment;
        document.getElementById("mermaid-diagram").style.transform = `scale(${zoomLevel})`;
    }

    function makeDraggable() {
        const elmnt = document.getElementById("mermaid-diagram");
        var pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        const dragHandle = document.getElementById("drag-handle");
        if (elmnt && dragHandle) {
            // if present, the header is where you move the DIV from:
            dragHandle.onmousedown = dragMouseDown;
            return true;
        }

        return false;

        /**
           * @param {MouseEvent} e
           */
        function dragMouseDown(e) {
            e.preventDefault();
            // get the mouse cursor position at startup:
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            // call a function whenever the cursor moves:
            document.onmousemove = elementDrag;
        }

        /**
           * @param {MouseEvent} e
           */
        function elementDrag(e) {
            e.preventDefault();
            // calculate the new cursor position:
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            // set the element's new position:
            elmnt.style.top = (elmnt.offsetTop - pos2) + "px";
            elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
        }

        function closeDragElement() {
            // stop moving when mouse button is released:
            document.onmouseup = null;
            document.onmousemove = null;
        }
    }

})();
