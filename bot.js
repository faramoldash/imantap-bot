Добавлена защита от DoS-атак через большие payload:
- MAX_BODY_SIZE = 100KB максимум для JSON запросов
- Проверка body.length в req.on('data')
- Возврат 413 Payload Too Large при превышении
- Разрыв соединения req.destroy() при атаке
