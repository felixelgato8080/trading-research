r"""
LA CUENTA TIENE QUE SER LA QUE SE ESPERA, Y SI NO, SE PARA.

POR QUE EXISTE ESTO
-------------------
El 14 sep el terminal cambio de cuenta demo varias veces en la misma hora, y nada se entero. En
una sola sesion de trabajo se leyo:

    169354542  XMGlobal-MT5 2   (la de todo el registro anterior)
    169363039  XMGlobal-MT5 2   (nueva, con un EA ajeno poniendo ordenes en GOLD#)
    108419791  XMGlobal-MT5 5   (la que se va a usar, spread mas bajo)

`mt5.initialize()` se engancha a LO QUE HAYA. Sin comprobarlo, las velas salen de una cuenta,
el spread se mide en otra y las ordenes se mandan a una tercera, todo con codigo de salida 0.
Y no es hipotetico: en esa misma sesion, el exportador saco velas de 108419791 mientras el
ejecutor, dos minutos despues, informaba de 169363039.

Peor todavia, las cuentas NO son equivalentes. Cada una trae su grupo de simbolos, y en el de
108419791 el spread es la mitad:

    EURUSD 2,20 pips  vs  EURUSD# 1,30      USDJPY 2,70  vs  USDJPY# 1,50

O sea que "la cuenta" no es un detalle administrativo: es que precio se mide y a que precio se
opera. Mezclarlas dentro de un registro lo invalida igual que mezclar Yahoo con XM.

QUE HACE
--------
Compara y PARA. No intenta cambiar de cuenta: para eso hacen falta credenciales, y este
proyecto no las toca ni las guarda. Lo unico que hace es negarse a trabajar sobre la cuenta
equivocada y decir cual hay puesta, para que la cambie una persona en el terminal.

Sin `--cuenta` no comprueba nada, que es como se portaba antes de existir.
"""


def exigir_cuenta(info, esperada):
    """
    Devuelve None si la cuenta vale, o el motivo por el que no, como texto.

    `info` es lo que devuelve `mt5.account_info()` y `esperada` el login que se pidio. Se separa
    del terminal para poder probarlo sin MT5: solo mira dos numeros.
    """
    if not esperada:
        return None
    if info is None:
        return "no se pudo leer la cuenta del terminal"
    if int(info.login) != int(esperada):
        return (
            f"el terminal esta en la cuenta {info.login} ({info.server}) y se esperaba "
            f"{esperada}.\nNo se toca nada: cada cuenta trae su grupo de simbolos y su spread, "
            "asi que trabajar\nsobre la equivocada mezcla dos series de precios en el mismo "
            "registro.\nCambia la cuenta en el terminal y vuelve a lanzarlo."
        )
    return None
