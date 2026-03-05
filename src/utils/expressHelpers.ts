export const getParamValue = (
    param: string | string[] | undefined,
): string | undefined =>
    typeof param === "string"
        ? param
        : Array.isArray(param)
          ? param[0]
          : undefined;
