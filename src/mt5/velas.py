"""
LAS VELAS DEL BROKER, para analizar con los mismos precios con los que se opera.

    python src/mt5/velas.py --salida=RUTA.json [--pares=USDJPY,GBPJPY] [--tf=5m,15m] [--n=3000]

POR QUE EXISTE
--------------
Hasta el 13 sep el analisis salia de Yahoo y las ordenes iban a XM. Midiendo la diferencia sobre
~2.940 velas de 5m por par aparecio un sesgo CONSTANTE, con Yahoo siempre por encima:

    USDJPY  +0,82p      EURJPY  +0,91p
    GBPJPY  +0,93p      AUDJPY  +1,35p

Las velas estaban bien alineadas —comparar T contra T daba 0,84-1,43 pips y contra T±5min daba
2,87-4,68— y media y mediana casi coincidian, que es la firma de un desfase sistematico y no de
ruido. Sobre los stops de 7-9 pips de `afinado` eso es el 9-19% del riesgo; sobre los 1,8 pips
de `video`, mas de la mitad.

Decidir en un libro y ejecutar en otro no se arregla con un ajuste: se arregla leyendo del mismo
sitio. Eso es esto.

LA HORA VA EN UTC, Y ESO NO ES UN DETALLE
-----------------------------------------
MT5 devuelve `time` como un epoch construido con la hora del SERVIDOR, no con UTC. XM va en
UTC+3 en verano. El mismo fallo aparecio el 13 sep en el medidor de spread: el informe por horas
salia desplazado tres horas, justo encima de la franja que decide. Aqui seria peor todavia,
porque las velas desplazadas casarian mal con cualquier otra fuente.

El desfase se deduce comparando la ultima vela con el reloj real, no se supone.

SOLO LEE. Este fichero no manda ordenes.
"""
import argparse
import io
import json
import os
import time

from cuenta import exigir_cuenta
from terminal import conectar
from simbolos import operables_de, simbolo_broker
from datetime import datetime, timezone

try:
    import MetaTrader5 as mt5
except ImportError:  # pragma: no cover - solo en maquinas sin terminal
    mt5 = None

PARES = ["USDJPY", "GBPJPY", "EURJPY", "AUDJPY"]

# Las que usa la estrategia. El nombre de la izquierda es el que entiende el resto del proyecto.
TF = {
    "5m": ("TIMEFRAME_M5", 300),
    "15m": ("TIMEFRAME_M15", 900),
    "1h": ("TIMEFRAME_H1", 3600),
    "1d": ("TIMEFRAME_D1", 86400),
}


# El paso de la vela con la que se lee el reloj del servidor.
PASO_M5 = 300
# A partir de aqui la vela mas nueva es de otro dia: mercado cerrado, no terminal averiado.
CERRADO = 3 * 3600


def deducir_desfase(mejor, ahora):
    """
    Los segundos que el reloj del servidor va por delante de UTC, leidos de la vela mas nueva.

    LA HORA DE UNA VELA ES LA DE SU APERTURA, y la mas nueva esta EN CURSO: su apertura cae entre
    0 y 300 segundos antes del ahora del servidor. Tomarla tal cual sesga la cuenta hasta cinco
    minutos, siempre hacia abajo, asi que se le suma medio paso y el error queda en +-150 s.

    Se redondea a la media hora porque hay husos a :30. Suponer +3 a pelo funcionaria hoy y
    fallaria al cambiar el horario.

    ESTO SOLO ES CIERTO SI LA VELA ES LA DE AHORA, y esta funcion no tiene forma de saberlo: si
    la vela llega media hora tarde, la cuenta sale limpia, redonda y desplazada un escalon. De
    comprobarlo se encarga `desfase_servidor`, que tiene con que.
    """
    return int(round((mejor + PASO_M5 / 2.0 - ahora) / 1800.0) * 1800)


def desfase_servidor(pares, anterior=None):
    """
    El desfase del servidor, contrastado con el de la vez pasada.

    POR QUE NO BASTA CON DEDUCIRLO. Ya ha fallado dos veces, y las dos en silencio:

        15 sep 01:15 UTC   la vela mas nueva llego ~30 min tarde. La cuenta cayo en el escalon
                           de al lado y el fichero salio fechado media hora en el futuro:
                           `div-ul-video` volvio a apuntar dos senales que ya tenia y guardo dos
                           salidas 30 minutos tarde.
        15 sep 22:25 UTC   el terminal, recien cambiado de cuenta, devolvio historial de 17,5 h
                           antes. El fichero salio 20,5 h adelantado y siete registros apuntaron
                           64 operaciones que ya tenian.

    Y NO SE ARREGLA MIRANDO SOLO LA CUENTA. Se penso en exigir que cayera cerca de la media hora
    exacta, pero un retraso de 30 minutos justos cae EN el escalon siguiente, a cero de distancia.
    Un numero redondo no prueba nada.

    Lo que si sirve es el desfase de la VEZ PASADA, que no depende de la vela de ahora:

      1. Con el se mide la antiguedad de la vela sin usar lo que se acaba de deducir. Si son
         horas, es el fin de semana, y ahi no hay reloj que leer: se conserva el de antes.
      2. Si no lo son y el desfase deducido NO coincide con el de antes, se para. El desfase de
         un broker cambia dos veces al año; que cambie hoy y justo en esta pasada es mucho menos
         probable que un terminal sirviendo velas viejas. Se falla cerrado: mejor una pasada
         perdida que un fichero mal fechado, que no falla, contamina.

    Cuando el cambio de horario sea de verdad, esto para hasta que se mire. Es a proposito: el
    fichero viejo sigue en su sitio, los grabadores lo ven rancio y no tocan nada. Para aceptar
    el desfase nuevo se borra el fichero de salida y se deja que la primera pasada lo fije.
    """
    mejor = None
    for p in pares:
        r = mt5.copy_rates_from_pos(p, mt5.TIMEFRAME_M5, 0, 1)  # ya son nombres del broker
        if r is not None and len(r):
            t = int(r[0]["time"])
            if mejor is None or t > mejor:
                mejor = t
    if mejor is None:
        return 0
    desfase = deducir_desfase(mejor, time.time())

    if anterior is None:
        # PRIMERA VEZ: no hay con que contrastar, asi que solo queda la unica cota que se
        # sostiene sola. Ningun broker del mundo esta a mas de 14 horas de UTC.
        if not (-12 * 3600 <= desfase <= 14 * 3600):
            raise SystemExit(
                f"el desfase deducido son {desfase / 3600:+.1f} h, que no existe en ningun "
                "broker.\nSuele significar que el terminal devolvio velas viejas (recien "
                "cambiado de cuenta,\no aun descargando historial). No se escribe nada: un "
                "fichero mal fechado envenena\nlos registros sin que nada falle."
            )
        return desfase

    # LA ANTIGUEDAD DE LA VELA, MEDIDA CON EL DESFASE DE ANTES y no con el de ahora. Es la unica
    # forma de preguntar "¿esta vela es de ahora?" sin usar el numero que se quiere comprobar.
    antiguedad = time.time() - (mejor - anterior)
    if antiguedad > CERRADO:
        print(f"la vela mas nueva tiene {antiguedad / 3600:.1f} h: mercado cerrado. De ahi no se "
              f"lee ningun reloj, asi que se conserva el desfase de antes ({anterior / 3600:+.1f} h).")
        return anterior
    if desfase != anterior:
        raise SystemExit(
            f"el desfase deducido son {desfase / 3600:+.1f} h y el de la pasada anterior era "
            f"{anterior / 3600:+.1f} h.\n"
            f"La vela mas nueva tiene {antiguedad / 60:.1f} min, o sea que el mercado esta "
            "abierto: lo mas probable\nno es que el broker haya cambiado de horario, sino que "
            "el terminal esta sirviendo velas\nviejas. No se escribe nada.\n\n"
            "Si el cambio de horario es de verdad, borra el fichero de salida y la primera "
            "pasada\nfijara el desfase nuevo."
        )
    return desfase


def sacar(simbolo, tf, n, desfase):
    """Las ultimas `n` velas de un simbolo, en el formato que entiende el resto del proyecto."""
    constante, paso = TF[tf]
    r = mt5.copy_rates_from_pos(simbolo, getattr(mt5, constante), 0, n)
    if r is None or len(r) == 0:
        return []
    out = []
    for v in r:
        o, h, l, c = float(v["open"]), float(v["high"]), float(v["low"]), float(v["close"])
        # LA MISMA CRIBA QUE HACE `datos.ts` CON YAHOO. Una vela con el cierre fuera del rango o
        # un minimo en cero es imposible, y envenena cualquier cosa que use stops.
        if min(o, h, l, c) <= 0:
            continue
        if c > h + 1e-9 or c < l - 1e-9 or o > h + 1e-9 or o < l - 1e-9:
            continue
        out.append({
            "t": int(v["time"]) - desfase,
            "o": o, "h": h, "l": l, "c": c,
            "v": int(v["tick_volume"]),
        })
    return out


def main():
    if mt5 is None:
        raise SystemExit("Falta el paquete MetaTrader5. Esto solo corre donde esta el terminal.")
    ap = argparse.ArgumentParser()
    ap.add_argument("--salida", required=True)
    ap.add_argument("--pares", default=",".join(PARES))
    ap.add_argument("--tf", default="5m,15m")
    ap.add_argument("--n", type=int, default=6000,
                    help="velas de la temporalidad mas corta; las demas se escalan")
    ap.add_argument("--cuenta", type=int, default=0,
                    help="login que DEBE tener el terminal; si no, no se escribe nada")
    ap.add_argument("--terminal", default="",
                    help="ruta a terminal64.exe; con varios instalados, cual usar")
    args = ap.parse_args()

    pares = [x.strip() for x in args.pares.split(",") if x.strip()]
    tfs = [x.strip() for x in args.tf.split(",") if x.strip()]
    # LAS DOS TEMPORALIDADES TIENEN QUE CUBRIR EL MISMO PERIODO.
    #
    # Con `n` igual para todas, 3.000 velas son 10 dias en 5m y 31 en 15m. Entonces una
    # divergencia de hace tres semanas se emparejaba con el principio del 5m y buscaba su
    # entrada ahi, en precio que no tiene nada que ver con ella. Medido el 14 sep, eso inventaba
    # operaciones con un 91% de acierto: no era una estrategia buena, era la misma operacion
    # contada cincuenta veces.
    #
    # `--n` se aplica a la temporalidad mas CORTA y el resto se escala para durar lo mismo.
    paso_corto = min(TF[t][1] for t in tfs)
    cuantas = {t: max(300, int(args.n * paso_corto / TF[t][1])) for t in tfs}
    for t in tfs:
        if t not in TF:
            raise SystemExit(f"temporalidad desconocida: {t}. Hay {', '.join(TF)}")

    mal = conectar(mt5, args.terminal)
    if mal:
        raise SystemExit(mal)

    # ANTES DE LEER UNA SOLA VELA. El terminal se engancha a la cuenta que haya puesta, y
    # cada cuenta trae su grupo de simbolos con su spread. Sacar las velas de la cuenta
    # equivocada mete en el registro precios de otro instrumento sin que nada falle.
    mal = exigir_cuenta(mt5.account_info(), args.cuenta)
    if mal:
        mt5.shutdown()
        raise SystemExit(mal)

    # COMO SE LLAMA CADA PAR AQUI, preguntado al terminal en vez de supuesto.
    #
    # El 14 sep el terminal cambio de cuenta demo y en la nueva los cruces solo existen con
    # sufijo: `GBPJPY` no existe, `GBPJPY#` si. Pidiendo el nombre pelado, MT5 contesta
    # "Terminal: Call failed" y `copy_rates_from_pos` devuelve None; el fichero salia con 7
    # pares de 12 y los grabadores seguian corriendo con lo que hubiera.
    # Y DE LOS QUE HAY, LOS QUE SE PUEDEN OPERAR. En esta cuenta conviven `EURUSD` (grupo
    # Standard, DESACTIVADO, 2,20 pips) y `EURUSD#` (Ultra Low, operable, 1,30). Sacar las velas
    # del primero seria medir sobre un instrumento que no se puede tocar y que ademas cuesta el
    # doble: decidir en un libro y ejecutar en otro, otra vez.
    todos = mt5.symbols_get() or []
    vivos = {s.name for s in todos}
    operables = operables_de(todos)
    nombres = {}
    sin_simbolo = []
    for p in pares:
        real = simbolo_broker(p, vivos, operables)
        if real is None:
            sin_simbolo.append(p)
            continue
        nombres[p] = real
        mt5.symbol_select(real, True)
    if sin_simbolo:
        print(f"NO EXISTEN EN ESTA CUENTA: {', '.join(sin_simbolo)}")
    renombrados = [f"{p}->{r}" for p, r in nombres.items() if p != r]
    if renombrados:
        # Que un par se pida con un nombre y se lea con otro tiene que VERSE. Si algun dia el
        # resolutor acierta con el simbolo equivocado, esta linea es lo unico que lo delata.
        print(f"SIMBOLOS RENOMBRADOS: {', '.join(sorted(renombrados))}")
    # EL DESFASE DE LA VEZ PASADA, del fichero que se va a sobrescribir. Solo se usa cuando la
    # vela mas nueva no sirve para leer el reloj, que en la practica es el fin de semana.
    anterior = None
    try:
        with io.open(args.salida, encoding="utf-8") as f:
            v = json.load(f).get("desfase")
        if isinstance(v, int) and -12 * 3600 <= v <= 14 * 3600:
            anterior = v
    except (OSError, ValueError):
        pass
    desfase = desfase_servidor(list(nombres.values()), anterior)

    datos = {}
    faltan = []
    for t in tfs:
        for p, real in nombres.items():
            vs = sacar(real, t, cuantas[t], desfase)
            if len(vs) < 300:
                faltan.append(f"{p} {t} ({len(vs)})")
                continue
            # La clave lleva el sufijo de Yahoo para que el resto del proyecto no note el cambio
            # de fuente: los registros, los pares y los informes hablan ese vocabulario.
            datos.setdefault(t, {})[f"{p}=X"] = vs
    cuenta = mt5.account_info()
    servidor = cuenta.server if cuenta is not None else "?"
    mt5.shutdown()

    if faltan:
        print(f"FALTAN {len(faltan)}: {', '.join(faltan)}")
    if not datos:
        raise SystemExit("no se saco ninguna vela. No se escribe nada.")

    salida = {
        "fuente": f"MT5 {servidor}",
        # DE QUE SIMBOLO SALIO CADA PAR, y no es un adorno.
        #
        # En esta cuenta conviven `EURUSD` (Standard, 2,20 pips) y `EURUSD#` (Ultra Low, 1,30).
        # Las velas son BID, asi que el mismo mercado da DOS series distintas segun el grupo: con
        # medio pip de diferencia constante, que sobre un stop de 18 pips es el 3% del riesgo.
        #
        # Escribirlo aqui permite que el grabador lo meta en sus ajustes y se NIEGUE a continuar
        # un registro empezado con el otro grupo. Es la misma guarda que ya impidio mezclar Yahoo
        # con XM; sin ella, un cambio de cuenta mezcla dos series sin que nada avise.
        "simbolos": nombres,
        "desfase": desfase,
        "sacadas": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tf": datos,
    }
    # Se escribe al lado y se renombra encima: el grabador puede estar leyendo este fichero.
    os.makedirs(os.path.dirname(os.path.abspath(args.salida)) or ".", exist_ok=True)
    tmp = args.salida + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(salida, f)
    os.replace(tmp, args.salida)

    for t, d in datos.items():
        primera = min(min(v["t"] for v in vs) for vs in d.values())
        ultima = max(max(v["t"] for v in vs) for vs in d.values())
        edad = (time.time() - ultima) / 60
        print(f"{t}: {len(d)} pares · {sum(len(v) for v in d.values())} velas · "
              f"cubre {(ultima - primera) / 86400:.1f} dias · ultima hace {edad:.0f} min")
    print(f"servidor {desfase / 3600:+.1f}h sobre UTC · guardado en {args.salida}")


if __name__ == "__main__":
    main()
