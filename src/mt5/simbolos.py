r"""
COMO SE LLAMA CADA PAR EN ESTE BROKER.

POR QUE ES UN FICHERO APARTE
----------------------------
El 14 sep el terminal cambio de cuenta demo y con ella cambio el juego de simbolos: en la cuenta
nueva los siete majors existen con el nombre pelado (`EURUSD`) pero los cinco cruces SOLO existen
con sufijo (`EURJPY#`, `GBPJPY#`, `AUDJPY#`, `CADJPY#`, `EURGBP#`).

El ejecutor ya sabia resolverlo; el exportador de velas no. Resultado: `velas.py` pidio `GBPJPY`,
MT5 contesto "Terminal: Call failed", y el fichero salio con 7 pares en vez de 12. Y como el
grabador sigue adelante mientras le queden mas de la mitad de los pares, `div-xm` —que opera
USDJPY, GBPJPY, EURJPY y AUDJPY— estuvo corriendo con UNO de sus cuatro pares sin que nada fallara.

La respuesta a eso no es copiar la funcion en el otro fichero: es que solo haya una. Si el
exportador y el ejecutor resuelven el nombre de formas distintas, se decide sobre un instrumento
y se opera sobre otro, que es el fallo que ya costo una reescritura en este proyecto.

MANDA EL QUE SE PUEDE OPERAR, NO EL QUE TIENE EL NOMBRE MAS BONITO
-----------------------------------------------------------------
En la cuenta del 14 sep conviven `EURUSD` y `EURUSD#`, y NO son intercambiables. Medido en vivo
sobre esa cuenta, con 12 muestras por simbolo:

    EURUSD  2,20 pips   EURUSD#  1,30      GBPUSD  2,10   GBPUSD#  1,10
    USDJPY  2,70        USDJPY#  1,50      AUDUSD  2,40   AUDUSD#  1,40

La mitad de spread. Y lo que lo decide del todo: los pelados salen con `trade_mode`
DESACTIVADO —`Forex\Standard\...`— mientras que los `#` son `Forex\Standard Ultra Low\...` y
estan COMPLETOS. Mismo tamaño de contrato, mismo lote minimo, mismos swaps, mismo margen.

O sea que preferir el nombre pelado, que es lo que esta funcion hacia, elegia un simbolo que
cuesta el doble y que ademas no se puede operar. Por eso ahora se pregunta primero cuales son
OPERABLES y solo despues se mira el nombre.

El respaldo —si ninguno es operable, vale cualquiera— existe para que las velas sigan llegando
aunque el broker tenga el instrumento cerrado: medir no es operar, y quedarse sin datos por eso
seria peor. Quien vaya a mandar una orden pasa solo los operables y se acabo.
"""


def simbolo_broker(par_yahoo, vivos, operables=None):
    """
    'USDJPY=X' -> el nombre que use este broker ('USDJPY', 'USDJPY#', 'USDJPYm', 'USDJPY.raw'...).

    `vivos` es el conjunto de simbolos que el terminal ofrece y `operables` el subconjunto que
    ademas se puede operar. Con `operables` a None se comporta como antes de que existiera.

    Devuelve None si no hay ninguno, que es informacion: ese par no se puede ni mirar aqui.
    """
    base = par_yahoo.replace("=X", "")
    # Ordenado para que la eleccion sea la misma en cada pasada. Sin esto, dos ejecuciones
    # seguidas podrian coger simbolos distintos segun como venga el conjunto.
    for conjunto in ([operables] if operables else []) + [vivos]:
        if base in conjunto:
            return base
        hallado = next((s for s in sorted(conjunto) if s.startswith(base)), None)
        if hallado is not None:
            return hallado
    return None


def operables_de(simbolos):
    """
    Los nombres que el broker deja operar, de una lista de `symbol_info`.

    Se separa del resto para poder probarlo sin terminal: entra cualquier cosa con `.name` y
    `.trade_mode`, y sale el conjunto. `trade_mode` 4 es SYMBOL_TRADE_MODE_FULL.
    """
    return {s.name for s in simbolos if getattr(s, "trade_mode", None) == 4}
