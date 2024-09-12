/**
 * Edge Impulse API
 * No description provided (generated by Openapi Generator https://github.com/openapitools/openapi-generator)
 *
 * The version of the OpenAPI document: 1.0.0
 * 
 *
 * NOTE: This class is auto generated by OpenAPI Generator (https://openapi-generator.tech).
 * https://openapi-generator.tech
 * Do not edit the class manually.
 */


export class CosineSimilarityIssueWindows {
    /**
    * The start time of this window in milliseconds
    */
    'windowStart': number;
    /**
    * The end time of this window in milliseconds
    */
    'windowEnd': number;
    /**
    * The cosine similarity score between this window and a window from the sample in the parent object.
    */
    'score': number;

    static discriminator: string | undefined = undefined;

    static attributeTypeMap: Array<{name: string, baseName: string, type: string}> = [
        {
            "name": "windowStart",
            "baseName": "windowStart",
            "type": "number"
        },
        {
            "name": "windowEnd",
            "baseName": "windowEnd",
            "type": "number"
        },
        {
            "name": "score",
            "baseName": "score",
            "type": "number"
        }    ];

    static getAttributeTypeMap() {
        return CosineSimilarityIssueWindows.attributeTypeMap;
    }
}

