openapi: 3.0.0
info:
  title: ${api_name}
  version: 1.0.0

paths:
  /_next/static/{proxy+}:
    get:
      x-yc-apigateway-integration:
        type: object_storage
        bucket: ${assets_bucket}
        object: _next/static/{proxy}
        service_account_id: ${service_account_id}
      parameters:
        - name: proxy
          in: path
          required: true
          schema:
            type: string

  /favicon.ico:
    get:
      x-yc-apigateway-integration:
        type: object_storage
        bucket: ${assets_bucket}
        object: public/favicon.ico
        service_account_id: ${service_account_id}

  /robots.txt:
    get:
      x-yc-apigateway-integration:
        type: object_storage
        bucket: ${assets_bucket}
        object: public/robots.txt
        service_account_id: ${service_account_id}

%{ if has_image ~}
  /_next/image:
    get:
      x-yc-apigateway-integration:
        type: cloud_functions
        function_id: ${image_function_id}
        service_account_id: ${service_account_id}
        payload_format_version: "2.0"
      parameters:
        - name: url
          in: query
          required: true
          schema:
            type: string
        - name: w
          in: query
          required: false
          schema:
            type: integer
        - name: q
          in: query
          required: false
          schema:
            type: integer
%{ endif ~}

%{ if has_server ~}
  /api/{proxy+}:
    x-yc-apigateway-any-method:
      x-yc-apigateway-integration:
        type: cloud_functions
        function_id: ${server_function_id}
        service_account_id: ${service_account_id}
        payload_format_version: "2.0"
      parameters:
        - name: proxy
          in: path
          required: false
          schema:
            type: string

  /{proxy+}:
    x-yc-apigateway-any-method:
      x-yc-apigateway-integration:
        type: cloud_functions
        function_id: ${server_function_id}
        service_account_id: ${service_account_id}
        payload_format_version: "2.0"
      parameters:
        - name: proxy
          in: path
          required: false
          schema:
            type: string

  /:
    x-yc-apigateway-any-method:
      x-yc-apigateway-integration:
        type: cloud_functions
        function_id: ${server_function_id}
        service_account_id: ${service_account_id}
        payload_format_version: "2.0"
%{ endif ~}
