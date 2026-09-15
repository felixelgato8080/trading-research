r"""
A QUE TERMINAL SE CONECTA CADA SCRIPT.

POR QUE HACE FALTA
------------------
`mt5.initialize()` sin argumentos se engancha al terminal que encuentre, y UN TERMINAL SOLO PUEDE
ESTAR EN UNA CUENTA A LA VEZ. Con dos sistemas distintos -el nuestro y un EA de oro- en dos
cuentas, eso no se sostiene: el 15 sep el terminal paso a la cuenta del oro y nuestra cadena se
quedo 16 horas parada, con 296 rechazos por cuenta equivocada.

La guarda hizo lo correcto —no operar donde no toca— pero el problema no era la guarda: era que
los dos sistemas se peleaban por el mismo terminal.

Con `--terminal` cada cadena abre el SUYO por su ruta, y da igual lo que haga el otro.

LO QUE ESTO NO HACE
-------------------
No inicia sesion ni toca credenciales. El terminal tiene que estar ya con su cuenta guardada; lo
unico que hace esto es elegir CUAL de los instalados se usa. Si no esta abierto, MT5 lo arranca.
"""


def conectar(mt5, ruta=""):
    """
    `mt5.initialize()` apuntando a un terminal concreto. Devuelve el motivo del fallo, o "".

    Se separa en una funcion porque los tres scripts lo hacen igual y porque asi el mensaje de
    error dice QUE terminal se intento abrir, que es lo primero que uno quiere saber.
    """
    ok = mt5.initialize(path=ruta) if ruta else mt5.initialize()
    if ok:
        return ""
    donde = f" ({ruta})" if ruta else ""
    return f"no se pudo conectar con el terminal{donde}: {mt5.last_error()}"
